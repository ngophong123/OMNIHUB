import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@omnihub/contracts';
import { digest, verifyPassword } from './domain';

export type Context = { tenantId: string; storeId: string; userId: string; role: Role; tokenHash: string; expiresAt: Date; correlationId: string };
export async function authenticate(client: PrismaClient, token: string | undefined, correlationId = ''): Promise<Context> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('SESSION_REQUIRED');
  const tokenHash = digest(token);
  const session = await client.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!session || !session.user.active || session.expiresAt <= new Date()) throw new UnauthorizedException('SESSION_EXPIRED');
  const membership = await client.membership.findUnique({ where: { userId_storeId: { userId: session.userId, storeId: session.storeId } } });
  if (!membership || membership.tenantId !== session.tenantId) throw new ForbiddenException('MEMBERSHIP_REQUIRED');
  return { tenantId: session.tenantId, storeId: session.storeId, userId: session.userId, role: membership.role, tokenHash, expiresAt: session.expiresAt, correlationId };
}
export async function reauthorize(tx: Prisma.TransactionClient, ctx: Context): Promise<Context> {
  const session = await tx.session.findUnique({ where: { tokenHash: ctx.tokenHash }, include: { user: true } });
  const membership = await tx.membership.findUnique({ where: { userId_storeId: { userId: ctx.userId, storeId: ctx.storeId } } });
  if (!session || !session.user.active || session.expiresAt <= new Date() || session.userId !== ctx.userId || session.tenantId !== ctx.tenantId || session.storeId !== ctx.storeId || !membership || membership.tenantId !== ctx.tenantId) throw new UnauthorizedException('SESSION_REVOKED');
  return { ...ctx, role: membership.role };
}
export async function login(client: PrismaClient, email: string, password: string, storeId: string) {
  const user = await client.user.findUnique({ where: { email: email.toLowerCase() } });
  // Run the same KDF for an unknown email to reduce username timing differences.
  const fallback = '0'.repeat(32) + ':' + '0'.repeat(128);
  const valid = verifyPassword(password, user?.passwordHash ?? fallback);
  if (!user || !user.active || !valid) throw new UnauthorizedException('INVALID_CREDENTIALS');
  const membership = await client.membership.findUnique({ where: { userId_storeId: { userId: user.id, storeId } } });
  if (!membership) throw new UnauthorizedException('INVALID_CREDENTIALS');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await client.session.create({ data: { tokenHash: digest(token), tenantId: membership.tenantId, userId: user.id, storeId, expiresAt } });
  return { token, expiresAt };
}
