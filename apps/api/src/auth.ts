import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@omnihub/contracts';
import { digest, verifyPassword } from './domain';
import { apiLogger } from './observability/logger';
import { getLogContext, updateLogContext } from './observability/request-context';

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
export async function login(client: PrismaClient, email: string, password: string, storeId: string) {
  const normalizedEmail = email.toLowerCase();
  const user = await client.user.findUnique({ where: { email: normalizedEmail } });
  // Run the same KDF for an unknown email to reduce username timing differences.
  const fallback = '0'.repeat(32) + ':' + '0'.repeat(128);
  const valid = verifyPassword(password, user?.passwordHash ?? fallback);
  if (!user || !user.active || !valid) {
    apiLogger.security('warn', 'AUTH_LOGIN_FAILED', { component: 'auth', storeId, emailHashPrefix: digest(normalizedEmail).slice(0, 16), reason: 'BAD_CREDENTIALS_OR_INACTIVE' });
    throw new UnauthorizedException('INVALID_CREDENTIALS');
  }
  const membership = await client.membership.findUnique({ where: { userId_storeId: { userId: user.id, storeId } } });
  if (!membership) {
    apiLogger.security('warn', 'AUTH_LOGIN_FAILED', { component: 'auth', storeId, userId: user.id, reason: 'MEMBERSHIP_NOT_FOUND' });
    throw new UnauthorizedException('INVALID_CREDENTIALS');
  }
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await client.session.create({ data: { tokenHash: digest(token), tenantId: membership.tenantId, userId: user.id, storeId, expiresAt } });
  updateLogContext({ tenantId: membership.tenantId, storeId, userId: user.id });
  apiLogger.security('info', 'AUTH_LOGIN_SUCCEEDED', { component: 'auth', tenantId: membership.tenantId, storeId, userId: user.id, role: membership.role });
  return { token, expiresAt };
}
