import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Role } from '@omnihub/contracts';
import { allowed, digest, hashPasswordAsync, verifyPasswordAsync } from './domain';
import { reauthorize, type Context } from './auth';
import { runSerializableTransactionWithRetry } from './database';
import { apiLogger } from './observability/logger';
import { getLogContext } from './observability/request-context';

const invitationRoles: readonly Role[] = ['MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'];
const DUMMY_PASSWORD_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

export class PilotAdmin {
  constructor(private readonly client: PrismaClient) {}

  async createInvitation(ctx: Context, input: { email: string; role: Role }) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    if (!invitationRoles.includes(input.role) || (ctx.role === 'MANAGER' && input.role === 'MANAGER')) {
      throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
    }
    const email = input.email.trim().toLowerCase();
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const invitation = await runSerializableTransactionWithRetry(this.client, async tx => {
      const current = await reauthorize(tx, ctx);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      if (!invitationRoles.includes(input.role) || (current.role === 'MANAGER' && input.role === 'MANAGER')) {
        throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
      }
      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser && await tx.membership.findUnique({ where: { userId_storeId: { userId: existingUser.id, storeId: current.storeId } } })) {
        throw new ConflictException('EMPLOYEE_ALREADY_ASSIGNED');
      }
      const pending = await tx.storeInvitation.findFirst({
        where: { tenantId: current.tenantId, storeId: current.storeId, email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (pending) throw new ConflictException('INVITATION_ALREADY_PENDING');
      const created = await tx.storeInvitation.create({
        data: { tenantId: current.tenantId, storeId: current.storeId, email, role: input.role, tokenHash: digest(token), invitedBy: current.userId, expiresAt },
      });
      await tx.audit.create({
        data: {
          tenantId: current.tenantId,
          storeId: current.storeId,
          actorId: current.userId,
          action: 'STORE_INVITATION_CREATED',
          entityId: created.id,
          commandKey: `store-invitation:create:${randomUUID()}`,
          correlationId: current.correlationId,
          details: { email, role: input.role, expiresAt: expiresAt.toISOString() },
        },
      });
      return created;
    }, { operation: 'store.invitation.create' });
    apiLogger.security('info', 'STORE_INVITATION_CREATED', {
      component: 'pilot-admin',
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      invitationId: invitation.id,
      role: invitation.role,
      correlationId: ctx.correlationId,
    });
    return { id: invitation.id, email, role: invitation.role, expiresAt: invitation.expiresAt, token };
  }

  async listInvitations(ctx: Context) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const rows = await this.client.storeInvitation.findMany({
      where: { tenantId: ctx.tenantId, storeId: ctx.storeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, email: true, role: true, createdAt: true, expiresAt: true, acceptedAt: true, revokedAt: true },
    });
    return rows.map(row => ({
      ...row,
      status: row.acceptedAt ? 'ACCEPTED' : row.revokedAt ? 'REVOKED' : row.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING',
    }));
  }

  async revokeInvitation(ctx: Context, id: string) {
    if (!allowed(ctx.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const invitation = await this.client.storeInvitation.findFirst({
      where: { id, tenantId: ctx.tenantId, storeId: ctx.storeId, acceptedAt: null, revokedAt: null },
    });
    if (!invitation) throw new NotFoundException('INVITATION_NOT_FOUND');
    if (ctx.role === 'MANAGER' && invitation.role === 'MANAGER') {
      throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
    }
    await runSerializableTransactionWithRetry(this.client, async tx => {
      const current = await reauthorize(tx, ctx);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      const target = await tx.storeInvitation.findFirst({
        where: { id, tenantId: current.tenantId, storeId: current.storeId },
        select: { id: true, email: true, role: true },
      });
      if (!target) throw new NotFoundException('INVITATION_NOT_FOUND');
      if (current.role === 'MANAGER' && target.role === 'MANAGER') {
        throw new ForbiddenException('INVITATION_ROLE_NOT_ALLOWED');
      }
      const changed = await tx.storeInvitation.updateMany({
        where: { id, tenantId: current.tenantId, storeId: current.storeId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (changed.count !== 1) throw new ConflictException('INVITATION_NOT_PENDING');
      await tx.audit.create({
        data: {
          tenantId: current.tenantId,
          storeId: current.storeId,
          actorId: current.userId,
          action: 'STORE_INVITATION_REVOKED',
          entityId: id,
          commandKey: `store-invitation:revoke:${randomUUID()}`,
          correlationId: current.correlationId,
          details: { email: target.email, role: target.role },
        },
      });
    }, { operation: 'store.invitation.revoke' });
    apiLogger.security('info', 'STORE_INVITATION_REVOKED', {
      component: 'pilot-admin',
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      invitationId: id,
      role: invitation.role,
      correlationId: ctx.correlationId,
    });
    return { id, revoked: true };
  }

  async acceptInvitation(token: string, password: string, correlationId = getLogContext()?.correlationId ?? '') {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');
    const tokenHash = digest(token);
    const now = new Date();
    const invitation = await this.client.storeInvitation.findFirst({
      where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    });
    if (!invitation) throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');

    const existing = await this.client.user.findUnique({ where: { email: invitation.email } });
    if (existing) {
      const valid = await verifyPasswordAsync(password, existing.active ? existing.passwordHash : DUMMY_PASSWORD_HASH);
      if (!existing.active || !valid) {
        apiLogger.security('warn', 'STORE_INVITATION_ACCEPT_DENIED', {
          component: 'pilot-admin',
          tenantId: invitation.tenantId,
          storeId: invitation.storeId,
          invitationId: invitation.id,
          reason: !existing.active ? 'USER_INACTIVE' : 'PASSWORD_MISMATCH',
          ...(correlationId ? { correlationId } : {}),
        });
        // Unified error prevents cross-tenant email existence / account status disclosure.
        throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');
      }
    }
    const passwordHash = existing ? undefined : await hashPasswordAsync(password);

    return runSerializableTransactionWithRetry(this.client, async tx => {
      const current = await tx.storeInvitation.findFirst({
        where: { id: invitation.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!current) throw new ConflictException('INVITATION_ALREADY_USED');
      const existingInTx = await tx.user.findUnique({ where: { email: current.email } });
      if (existingInTx) {
        if (!existingInTx.active || !existing || existingInTx.id !== existing.id) {
          throw new UnauthorizedException('INVITATION_INVALID_OR_EXPIRED');
        }
        const alreadyMember = await tx.membership.findUnique({
          where: { userId_storeId: { userId: existingInTx.id, storeId: current.storeId } },
        });
        if (alreadyMember) throw new ConflictException('EMPLOYEE_ALREADY_ASSIGNED');
      }
      const user = existingInTx ?? await tx.user.create({ data: { email: current.email, passwordHash: passwordHash! } });
      const claimed = await tx.storeInvitation.updateMany({
        where: { id: current.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException('INVITATION_ALREADY_USED');
      await tx.membership.create({
        data: { tenantId: current.tenantId, storeId: current.storeId, userId: user.id, role: current.role },
      });
      await tx.audit.create({
        data: {
          tenantId: current.tenantId,
          storeId: current.storeId,
          actorId: user.id,
          action: 'STORE_INVITATION_ACCEPTED',
          entityId: current.id,
          commandKey: `store-invitation:accept:${current.id}`,
          correlationId,
          details: { email: current.email, role: current.role },
        },
      });
      apiLogger.security('info', 'STORE_INVITATION_ACCEPTED', {
        component: 'pilot-admin',
        tenantId: current.tenantId,
        storeId: current.storeId,
        invitationId: current.id,
        userId: user.id,
        role: current.role,
        ...(correlationId ? { correlationId } : {}),
      });
      return { accepted: true, email: current.email, storeId: current.storeId };
    }, { operation: 'store.invitation.accept' });
  }
}
