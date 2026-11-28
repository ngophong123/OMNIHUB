import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type Redis from 'ioredis';
import { digest } from './domain';
import { apiLogger } from './observability/logger';
import { apiMetrics } from './observability/metrics';

export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_AUTH_LOGIN_IP_LIMIT = 60;
export const DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT = 10;
export const DEFAULT_AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS = 900;
export const DEFAULT_AUTH_ACCOUNT_WINDOW_MS = DEFAULT_AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS * 1_000;
export const DEFAULT_PUBLIC_INVITATION_RATE_LIMIT = 10;
export const DEFAULT_QR_ORDER_RATE_LIMIT = 20;
export const DEFAULT_PUBLIC_API_RATE_LIMIT = 60;
export const DEFAULT_WEBHOOK_RATE_LIMIT = 120;

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

const checkAccountLockScript = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then return ttl end
return 0
`;

const recordAccountFailureScript = `
local existingLockTtl = redis.call('PTTL', KEYS[2])
if existingLockTtl > 0 then
  return { tonumber(ARGV[2]) + 1, existingLockTtl, 1, 0 }
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local locked = 0
local newlyLocked = 0
if count >= tonumber(ARGV[2]) then
  local lockCount = redis.call('INCR', KEYS[2])
  if lockCount == 1 then
    newlyLocked = 1
  end
  redis.call('PEXPIRE', KEYS[2], ttl)
  locked = 1
end
return { count, ttl, locked, newlyLocked }
`;

const resetAccountFailuresScript = `
if redis.call('PTTL', KEYS[1]) > 0 then
  redis.call('PEXPIRE', KEYS[1], 0)
end
if redis.call('PTTL', KEYS[2]) > 0 then
  redis.call('PEXPIRE', KEYS[2], 0)
end
return 1
`;

export type RateDecision = { count: number; ttlMs: number };
export type RateLimitRedis = Pick<Redis, 'eval'>;
export type AccountLockStatus = { locked: boolean; ttlMs: number; retryAfterSeconds: number };
export type AccountFailureDecision = {
  count: number;
  ttlMs: number;
  locked: boolean;
  newlyLocked: boolean;
  retryAfterSeconds: number;
};
export type AuthAccountProtectionOptions = { limit?: number; windowMs?: number };
export type AuthAccountRequestContext = {
  redis: RateLimitRedis;
  limit: number;
  windowMs: number;
  onAccountLocked?: (retryAfterSeconds: number) => void;
};

type ScopedRateLimitedRequest = Request & { _omnihubSpecificRateLimitApplied?: boolean };

const authAccountStorage = new AsyncLocalStorage<AuthAccountRequestContext>();
let redisHealthProbe: (() => Promise<string>) | undefined;

export function setRateLimitRedisHealthProbe(probe: () => Promise<string>): void {
  redisHealthProbe = probe;
}

export async function rateLimitRedisReady(): Promise<boolean> {
  if (!redisHealthProbe) return false;
  try {
    return (await redisHealthProbe()) === 'PONG';
  } catch {
    return false;
  }
}

export function configuredRateLimit(
  name: string,
  fallback: number,
  maximum: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

/** Resolves IP rate limit for /auth/login, honoring AUTH_LOGIN_IP_LIMIT first and AUTH_LOGIN_RATE_LIMIT fallback. */
export function resolveAuthLoginIpLimit(env: NodeJS.ProcessEnv = process.env): number {
  if (env.AUTH_LOGIN_IP_LIMIT !== undefined) {
    return configuredRateLimit('AUTH_LOGIN_IP_LIMIT', DEFAULT_AUTH_LOGIN_IP_LIMIT, 1_000, env);
  }
  return configuredRateLimit('AUTH_LOGIN_RATE_LIMIT', DEFAULT_AUTH_LOGIN_IP_LIMIT, 1_000, env);
}

/** Normalizes an email address consistently across login lookup and account rate-limit keys. */
export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Computes a deterministic, cross-replica SHA-256 account digest without storing plaintext email in Redis. */
export function accountRateLimitIdentifier(email: string): string {
  return digest(`omnihub:auth-account-rate:v1:${normalizeAccountEmail(email)}`);
}

export function accountFailureKey(email: string): string {
  return `omnihub:rate:v1:acct-fail:${accountRateLimitIdentifier(email)}`;
}

export function accountLockKey(email: string): string {
  return `omnihub:rate:v1:acct-lock:${accountRateLimitIdentifier(email)}`;
}

export async function incrementRateWindow(redis: RateLimitRedis, key: string, windowMs: number): Promise<RateDecision> {
  const result = await redis.eval(incrementScript, 1, key, String(windowMs));
  if (!Array.isArray(result) || result.length !== 2) throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  const count = Number(result[0]);
  const ttlMs = Number(result[1]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  }
  return { count, ttlMs };
}

/** Checks whether the normalized account is currently locked in Redis before running CPU-expensive password hashing. */
export async function checkAccountLoginLock(redis: RateLimitRedis, email: string): Promise<AccountLockStatus> {
  const result = await redis.eval(checkAccountLockScript, 1, accountLockKey(email));
  const ttlMs = Number(result);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  }
  if (ttlMs === 0) {
    return { locked: false, ttlMs: 0, retryAfterSeconds: 0 };
  }
  return {
    locked: true,
    ttlMs,
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

/** Increments the per-account failed-password counter and arms the lockout key once the threshold is reached. */
export async function recordAccountLoginFailure(
  redis: RateLimitRedis,
  email: string,
  options: AuthAccountProtectionOptions = {},
): Promise<AccountFailureDecision> {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? (options.limit as number)
    : DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT;
  const windowMs = Number.isInteger(options.windowMs) && (options.windowMs as number) > 0
    ? (options.windowMs as number)
    : DEFAULT_AUTH_ACCOUNT_WINDOW_MS;

  const result = await redis.eval(
    recordAccountFailureScript,
    2,
    accountFailureKey(email),
    accountLockKey(email),
    String(windowMs),
    String(limit),
  );
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  }
  const count = Number(result[0]);
  const ttlMs = Number(result[1]);
  const lockedFlag = Number(result[2]);
  const newlyLockedFlag = Number(result[3]);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 0 ||
    (lockedFlag !== 0 && lockedFlag !== 1) ||
    (newlyLockedFlag !== 0 && newlyLockedFlag !== 1)
  ) {
    throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  }
  return {
    count,
    ttlMs,
    locked: lockedFlag === 1,
    newlyLocked: newlyLockedFlag === 1,
    retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

/** Immediately expires per-account failure and lock keys via PEXPIRE 0 without invoking DEL (forbidden by Redis ACL). */
export async function resetAccountLoginFailures(redis: RateLimitRedis, email: string): Promise<void> {
  const result = await redis.eval(resetAccountFailuresScript, 2, accountFailureKey(email), accountLockKey(email));
  if (Number(result) !== 1) {
    throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  }
}

export function getAuthAccountRequestContext(): AuthAccountRequestContext | undefined {
  return authAccountStorage.getStore();
}

export function runWithAuthAccountContext<T>(ctx: AuthAccountRequestContext, fn: () => T): T {
  return authAccountStorage.run(ctx, fn);
}

/** Attaches per-account brute-force protection context and Retry-After header propagation to /auth/login requests. */
export function createAuthAccountProtectionMiddleware(
  redis: RateLimitRedis,
  options: AuthAccountProtectionOptions = {},
): RequestHandler {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
    ? (options.limit as number)
    : DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT;
  const windowMs = Number.isInteger(options.windowMs) && (options.windowMs as number) > 0
    ? (options.windowMs as number)
    : DEFAULT_AUTH_ACCOUNT_WINDOW_MS;

  return (_req: Request, res: Response, next: NextFunction) => {
    runWithAuthAccountContext(
      {
        redis,
        limit,
        windowMs,
        onAccountLocked: retryAfterSeconds => {
          res.setHeader('Retry-After', retryAfterSeconds);
        },
      },
      () => next(),
    );
  };
}

export function createRedisRateLimiter(
  redis: RateLimitRedis,
  options: { prefix: string; limit: number; windowMs: number; skipIfAlreadyLimited?: boolean; markSpecificLimit?: boolean },
): RequestHandler {
  const prefix = options.prefix.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 1;
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  return (req: Request, res: Response, next: NextFunction) => {
    const scopedReq = req as ScopedRateLimitedRequest;
    if (options.skipIfAlreadyLimited && scopedReq._omnihubSpecificRateLimitApplied) {
      next();
      return;
    }
    if (options.markSpecificLimit) {
      scopedReq._omnihubSpecificRateLimitApplied = true;
    }
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `omnihub:rate:v1:${prefix}:${digest(address)}`;
    void incrementRateWindow(redis, key, windowMs)
      .then(({ count, ttlMs }) => {
        const remaining = Math.max(0, limit - count);
        const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
        res.setHeader('RateLimit-Limit', limit);
        res.setHeader('RateLimit-Remaining', remaining);
        res.setHeader('RateLimit-Reset', resetSeconds);
        if (count > limit) {
          res.setHeader('Retry-After', resetSeconds);
          const correlationId = res.getHeader('x-correlation-id');
          apiMetrics.recordRateLimitDecision(prefix, 'blocked_429');
          apiLogger.security('warn', 'RATE_LIMITED', {
            component: 'rate-limiter',
            prefix,
            remaining: 0,
            resetSeconds,
            ...(correlationId ? { correlationId } : {}),
          });
          res.status(429).json({ code: 'RATE_LIMITED', correlationId });
          return;
        }
        apiMetrics.recordRateLimitDecision(prefix, 'allowed');
        next();
      })
      .catch((error: unknown) => {
        // Protected routes fail closed: a Redis outage cannot reset counters on each API replica.
        const correlationId = res.getHeader('x-correlation-id');
        apiMetrics.recordRateLimitDecision(prefix, 'unavailable_503');
        apiLogger.ops('error', 'RATE_LIMITER_UNAVAILABLE', {
          component: 'rate-limiter',
          prefix,
          errorType: error instanceof Error ? error.name : typeof error,
          ...(correlationId ? { correlationId } : {}),
        });
        res.status(503).json({ code: 'RATE_LIMITER_UNAVAILABLE', correlationId });
      });
  };
}

/** Registers dual-key auth, public invitation, QR order, public API, and webhook rate limiters in specificity order. */
export function configurePublicAndAuthRateLimits(
  app: { use(path: string, handler: RequestHandler): unknown },
  redis: RateLimitRedis,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const windowMs = configuredRateLimit('RATE_LIMIT_WINDOW_SECONDS', DEFAULT_RATE_LIMIT_WINDOW_SECONDS, 3_600, env) * 1_000;
  const loginIpLimit = resolveAuthLoginIpLimit(env);
  const accountFailureLimit = configuredRateLimit(
    'AUTH_ACCOUNT_FAILURE_LIMIT',
    DEFAULT_AUTH_ACCOUNT_FAILURE_LIMIT,
    100,
    env,
  );
  const accountWindowMs =
    configuredRateLimit(
      'AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS',
      DEFAULT_AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS,
      86_400,
      env,
    ) * 1_000;
  const invitationLimit = configuredRateLimit(
    'PUBLIC_INVITATION_RATE_LIMIT',
    DEFAULT_PUBLIC_INVITATION_RATE_LIMIT,
    200,
    env,
  );
  const qrOrderLimit = configuredRateLimit('QR_ORDER_RATE_LIMIT', DEFAULT_QR_ORDER_RATE_LIMIT, 200, env);
  const publicLimit = configuredRateLimit('PUBLIC_API_RATE_LIMIT', DEFAULT_PUBLIC_API_RATE_LIMIT, 1_000, env);
  const webhookLimit = configuredRateLimit('WEBHOOK_RATE_LIMIT', DEFAULT_WEBHOOK_RATE_LIMIT, 5_000, env);

  app.use('/auth/login', createRedisRateLimiter(redis, { prefix: 'login', limit: loginIpLimit, windowMs }));
  app.use('/auth/login', createAuthAccountProtectionMiddleware(redis, { limit: accountFailureLimit, windowMs: accountWindowMs }));
  app.use(
    '/public/invitations/',
    createRedisRateLimiter(redis, { prefix: 'invitation', limit: invitationLimit, windowMs, markSpecificLimit: true }),
  );
  app.use(
    '/public/table-sessions/orders',
    createRedisRateLimiter(redis, { prefix: 'qr-order', limit: qrOrderLimit, windowMs, markSpecificLimit: true }),
  );
  app.use(
    '/public/',
    createRedisRateLimiter(redis, { prefix: 'public', limit: publicLimit, windowMs, skipIfAlreadyLimited: true }),
  );
  app.use('/webhooks/', createRedisRateLimiter(redis, { prefix: 'webhook', limit: webhookLimit, windowMs }));
}
