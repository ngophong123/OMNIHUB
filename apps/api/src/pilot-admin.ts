import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '@omnihub/contracts';
import { allowed, digest, hashPassword, verifyPassword } from './domain';
import { reauthorize, type Context } from './auth';

const invitationRoles: readonly Role[] = ['MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'];

export class PilotAdmin {
  constructor(private readonly client: PrismaClient) {}

  async createInvitation(ctx: Context, input: { email: string; role: Role }) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    if (!invitationRoles.includes(input.role) || (ctx.role === 'MANAGER' && input.role === 'MANAGER')) throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
    const email = input.email.trim().toLowerCase();
    const existingUser = await this.client.user.findUnique({ where: { email } });
    if (existingUser && await this.client.membership.findUnique({ where: { userId_storeId: { userId: existingUser.id, storeId: ctx.storeId } } })) throw new ConflictException('EMPLOYEE_ALREADY_ASSIGNED');
    const pending = await this.client.storeInvitation.findFirst({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (pending) throw new ConflictException('INVITATION_ALREADY_PENDING');
    const token = randomBytes(32).toString('hex'); const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const invitation = await this.client.$transaction(async tx => {
      const current = await reauthorize(tx, ctx);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      if (!invitationRoles.includes(input.role) || (current.role === 'MANAGER' && input.role === 'MANAGER')) throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
      const created = await tx.storeInvitation.create({ data: { tenantId: current.tenantId, storeId: current.storeId, email, role: input.role, tokenHash: digest(token), invitedBy: current.userId, expiresAt } });
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: current.userId, action: 'STORE_INVITATION_CREATED', entityId: created.id, commandKey: `store-invitation:create:${randomUUID()}`, correlationId: current.correlationId, details: { email, role: input.role, expiresAt: expiresAt.toISOString() } } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { id: invitation.id, email, role: invitation.role, expiresAt: invitation.expiresAt, token };
  }

  async listInvitations(ctx: Context) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const rows = await this.client.storeInvitation.findMany({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, email: true, role: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true } });
    return rows.map(row => ({ ...row, status: row.acceptedAt ? 'ACCEPTED' : row.revokedAt ? 'REVOKED' : row.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING' }));
  }

  async revokeInvitation(ctx: Context, id: string) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const invitation = await this.client.storeInvitation.findFirst({ where: { id, tenantId: ctx.tenantId, storeId: ctx.storeId, acceptedAt: null, revokedAt: null } });
    if (!invitation) throw new NotFoundException('INVITATION_NOT_FOUND');
    await this.client.$transaction(async tx => {
      const current = await reauthorize(tx, ctx);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      const changed = await tx.storeInvitation.updateMany({ where: { id, tenantId: current.tenantId, storeId: current.storeId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
      if (changed.count !== 1) throw new ConflictException('INVITATION_NOT_PENDING');
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: current.userId, action: 'STORE_INVITATION_REVOKED', entityId: id, commandKey: `store-invitation:revoke:${randomUUID()}`, correlationId: current.correlationId, details: { email: invitation.email, role: invitation.role } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { id, revoked: true };
  }

  async acceptInvitation(token: string, password: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');
    const tokenHash = digest(token); const now = new Date();
    const invitation = await this.client.storeInvitation.findFirst({ where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } });
    if (!invitation) throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');
    const existing = await this.client.user.findUnique({ where: { email: invitation.email } });
    if (existing && !verifyPassword(password, existing.passwordHash)) throw new UnauthorizedException('EXISTING_ACCOUNT_PASSWORD_REQUIRED');
    const passwordHash = existing ? undefined : hashPassword(password);
    return this.client.$transaction(async tx => {
      const current = await tx.storeInvitation.findFirst({ where: { id: invitation.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (!current) throw new ConflictException('INVITATION_ALREADY_USED');
      const user = existing ?? await tx.user.create({ data: { email: current.email, passwordHash: passwordHash! } });
      const claimed = await tx.storeInvitation.updateMany({ where: { id: current.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw new ConflictException('INVITATION_ALREADY_USED');
      await tx.membership.create({ data: { tenantId: current.tenantId, storeId: current.storeId, userId: user.id, role: current.role } });
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: user.id, action: 'STORE_INVITATION_ACCEPTED', entityId: current.id, commandKey: `store-invitation:accept:${current.id}`, correlationId: '', details: { email: current.email, role: current.role } } });
      return { accepted: true, email: current.email, storeId: current.storeId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
