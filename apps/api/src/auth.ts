import { ForbiddenException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@omnihub/contracts';
import { digest, verifyPasswordAsync } from './domain';
import { apiLogger } from './observability/logger';
import { apiMetrics } from './observability/metrics';
import { getLogContext, updateLogContext } from './observability/request-context';
import {
  checkAccountLoginLock,
  DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT,
  DEFAULT_AUTH_ACCOUNT_WINDOW_MS,
  getAuthAccountRequestContext,
  normalizeAccountEmail,
  recordAccountLoginFailure,
  resetAccountLoginFailures,
  type AuthAccountRequestContext,
  type RateLimitRedis,
} from './rate-limit';

const EPHEMERAL_LOG_HMAC_KEY = randomBytes(32);

export class AccountLockedException extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super('ACCOUNT_LOCKED_RETRY_LATER', 429);
  }
}

export type LoginProtectionOptions = {
  redis?: RateLimitRedis;
  limit?: number;
  windowMs?: number;
  onAccountLocked?: (retryAfterSeconds: number) => void;
};

/** Computes a domain-separated keyed HMAC prefix so failed-login correlation never uses unsalted email hashes. */
export function authEmailHmacPrefix(normalizedEmail: string): string {
  const configuredSecret = process.env.LOG_HMAC_SECRET || process.env.QR_TOKEN_SECRET;
  const key = configuredSecret ? configuredSecret : EPHEMERAL_LOG_HMAC_KEY;
  return createHmac('sha256', key)
    .update(`omnihub:auth-login-email:v1:${normalizedEmail}`)
    .digest('hex')
    .slice(0, 16);
}

function resolveAccountProtection(options?: LoginProtectionOptions): AuthAccountRequestContext | undefined {
  if (options?.redis) {
    return {
      redis: options.redis,
      limit: options.limit ?? DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT,
      windowMs: options.windowMs ?? DEFAULT_AUTH_ACCOUNT_WINDOW_MS,
      onAccountLocked: options.onAccountLocked,
    };
  }
  return getAuthAccountRequestContext();
}

function handleAccountRateLimiterFailure(error: unknown, correlationId?: string): never {
  apiMetrics.recordRateLimitDecision('login_account', 'unavailable_503');
  apiLogger.ops('error', 'RATE_LIMITER_UNAVAILABLE', {
    component: 'rate-limiter',
    prefix: 'login_account',
    errorType: error instanceof Error ? error.name : typeof error,
    ...(correlationId ? { correlationId } : {}),
  });
  throw new ServiceUnavailableException('RATE_LIMITER_UNAVAILABLE');
}

export type Context = { tenantId: string; storeId: string; userId: string; role: Role; tokenHash: string; expiresAt: Date; correlationId: string };
export async function authenticate(client: PrismaClient, token: string | undefined, correlationId = ''): Promise<Context> {
  const effectiveCorrelationId = correlationId || getLogContext()?.correlationId || '';
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('SESSION_REQUIRED');
  const tokenHash = digest(token);
  const session = await client.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session || !session.user.active || session.expiresAt <= new Date()) {
    apiLogger.security('warn', 'AUTH_SESSION_REJECTED', {
      component: 'auth',
      reason: !session ? 'SESSION_NOT_FOUND' : !session.user.active ? 'USER_INACTIVE' : 'SESSION_EXPIRED',
      ...(effectiveCorrelationId ? { correlationId: effectiveCorrelationId } : {}),
    });
    throw new UnauthorizedException('SESSION_EXPIRED');
  }
  const membership = await client.membership.findUnique({ where: { userId_storeId: { userId: session.userId, storeId: session.storeId } } });
  if (!membership || membership.tenantId !== session.tenantId) {
    apiLogger.security('warn', 'AUTH_MEMBERSHIP_DENIED', {
      component: 'auth',
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.userId,
      ...(effectiveCorrelationId ? { correlationId: effectiveCorrelationId } : {}),
    });
    throw new ForbiddenException('MEMBERSHIP_REQUIRED');
  }
  updateLogContext({ tenantId: session.tenantId, storeId: session.storeId, userId: session.userId });
  return { tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, role: membership.role, tokenHash, expiresAt: session.expiresAt, correlationId: effectiveCorrelationId };
}

export async function reauthorize(tx: Prisma.TransactionClient, ctx: Context): Promise<Context> {
  const session = await tx.session.findUnique({ where: { tokenHash: ctx.tokenHash }, include: { user: true } });
  const membership = await tx.membership.findUnique({ where: { userId_storeId: { userId: ctx.userId, storeId: ctx.storeId } } });
  if (!session || !session.user.active || session.expiresAt <= new Date() || session.userId !== ctx.userId || session.tenantId !== ctx.tenantId || session.storeId !== ctx.storeId || !membership || membership.tenantId !== ctx.tenantId) {
    apiLogger.security('warn', 'AUTH_REAUTHORIZE_REVOKED', {
      component: 'auth',
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    });
    throw new UnauthorizedException('SESSION_REVOKED');
  }
  return { ...ctx, role: membership.role };
}

export async function login(
  client: PrismaClient,
  email: string,
  password: string,
  storeId: string,
  protectionOptions?: LoginProtectionOptions,
) {
  const normalizedEmail = normalizeAccountEmail(email);
  const accountTag = authEmailHmacPrefix(normalizedEmail);
  const correlationId = getLogContext()?.correlationId;
  const protection = resolveAccountProtection(protectionOptions);

  if (protection) {
    let lockState: Awaited<ReturnType<typeof checkAccountLoginLock>>;
    try {
      lockState = await checkAccountLoginLock(protection.redis, normalizedEmail);
    } catch (error) {
      handleAccountRateLimiterFailure(error, correlationId);
    }
    if (lockState.locked) {
      protection.onAccountLocked?.(lockState.retryAfterSeconds);
      apiMetrics.recordRateLimitDecision('login_account', 'blocked_429');
      throw new AccountLockedException(lockState.retryAfterSeconds);
    }
  }

  const user = await client.user.findUnique({ where: { email: normalizedEmail } });
  // Run the same KDF for an unknown email to reduce username timing differences.
  const fallback = '0'.repeat(32) + ':' + '0'.repeat(128);
  const valid = await verifyPasswordAsync(password, user?.passwordHash ?? fallback);
  if (!user || !user.active || !valid) {
    if (protection) {
      let failure: Awaited<ReturnType<typeof recordAccountLoginFailure>>;
      try {
        failure = await recordAccountLoginFailure(protection.redis, normalizedEmail, {
          limit: protection.limit,
          windowMs: protection.windowMs,
        });
      } catch (error) {
        handleAccountRateLimiterFailure(error, correlationId);
      }
      if (failure.locked) {
        protection.onAccountLocked?.(failure.retryAfterSeconds);
        apiMetrics.recordRateLimitDecision('login_account', 'blocked_429');
        if (failure.newlyLocked) {
          apiLogger.security('warn', 'AUTH_ACCOUNT_LOCKED', {
            component: 'auth',
            storeId,
            accountTag,
            failedAttempts: failure.count,
            retryAfterSeconds: failure.retryAfterSeconds,
            ...(correlationId ? { correlationId } : {}),
          });
        }
        throw new AccountLockedException(failure.retryAfterSeconds);
      }
      apiMetrics.recordRateLimitDecision('login_account', 'allowed');
    }
    apiLogger.security('warn', 'AUTH_LOGIN_FAILED', {
      component: 'auth',
      storeId,
      accountTag,
      reason: 'BAD_CREDENTIALS_OR_INACTIVE',
      ...(correlationId ? { correlationId } : {}),
    });
    throw new UnauthorizedException('INVALID_CREDENTIALS');
  }

  const membership = await client.membership.findUnique({ where: { userId_storeId: { userId: user.id, storeId } } });
  if (!membership) {
    apiLogger.security('warn', 'AUTH_LOGIN_FAILED', {
      component: 'auth',
      storeId,
      userId: user.id,
      reason: 'MEMBERSHIP_NOT_FOUND',
      ...(correlationId ? { correlationId } : {}),
    });
    throw new UnauthorizedException('INVALID_CREDENTIALS');
  }

  if (protection) {
    try {
      await resetAccountLoginFailures(protection.redis, normalizedEmail);
    } catch (error) {
      handleAccountRateLimiterFailure(error, correlationId);
    }
    apiMetrics.recordRateLimitDecision('login_account', 'allowed');
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await client.session.create({ data: { tokenHash: digest(token), tenantId: membership.tenantId, userId: user.id, storeId, expiresAt } });
  updateLogContext({ tenantId: membership.tenantId, storeId, userId: user.id });
  apiLogger.security('info', 'AUTH_LOGIN_SUCCEEDED', {
    component: 'auth',
    tenantId: membership.tenantId,
    storeId,
    userId: user.id,
    role: membership.role,
    ...(correlationId ? { correlationId } : {}),
  });
  return { token, expiresAt };
}
