import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CashMovementCommand, CashRegisterInput, CashShiftClose, CashShiftOpen } from '@omnihub/contracts';
import type { Context } from './auth';
import { CommandBus, scope, type Result } from './commands';
import { allowed, businessDate, cashExpected } from './domain';

export class CashShifts extends CommandBus {
  async registers(ctx: Context) {
    return this.db.cashRegister.findMany({ where: { ...scope(ctx), active: true }, orderBy: { name: 'asc' } });
  }
  async assignments(ctx: Context) {
    return this.db.membership.findMany({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId, role: { in: ['OWNER', 'MANAGER', 'CASHIER'] }, user: { active: true } }, select: { userId: true, role: true, user: { select: { email: true } } }, orderBy: { user: { email: 'asc' } } });
  }
  async createRegister(ctx: Context, key: string, input: CashRegisterInput): Promise<Result> {
    return this.command(ctx, key, 'cash.register.changed', input, async tx => {
      const register = await tx.cashRegister.create({ data: { ...scope(ctx), name: input.name } });
      return { id: register.id, version: register.version };
    }, 'cashApprove');
  }
  async history(ctx: Context) {
    const shifts = await this.db.cashShift.findMany({ where: scope(ctx), include: { register: { select: { name: true } }, movements: { orderBy: { createdAt: 'asc' } }, payments: { select: { id: true, orderId: true, amount: true, tendered: true, change: true, businessDate: true, createdAt: true } } }, orderBy: { openedAt: 'desc' }, take: 100 });
    const cashiers = await this.db.membership.findMany({ where: { ...scope(ctx), userId: { in: [...new Set(shifts.map(s => s.cashierId))] } }, select: { userId: true, user: { select: { email: true } } } });
    const emailByUser = new Map(cashiers.map(c => [c.userId, c.user.email]));
    return shifts.map(shift => ({ ...shift, cashierEmail: emailByUser.get(shift.cashierId) ?? 'Former store member' }));
  }
  async open(ctx: Context, key: string, input: CashShiftOpen): Promise<Result> {
    return this.command(ctx, key, 'cash.shift.opened', input, async (tx, current) => {
      const register = await tx.cashRegister.findFirst({ where: { ...scope(ctx), id: input.registerId, active: true } });
      if (!register) throw new NotFoundException('REGISTER_NOT_FOUND');
      const cashierId = input.cashierId ?? current.userId;
      if (cashierId !== current.userId && !allowed(current.role, 'admin')) throw new ForbiddenException('CASHIER_ASSIGNMENT_FORBIDDEN');
      const membership = await tx.membership.findUnique({ where: { userId_storeId: { userId: cashierId, storeId: current.storeId } }, include: { user: { select: { active: true } } } });
      if (!membership || membership.tenantId !== current.tenantId || !membership.user.active || !allowed(membership.role, 'cashShift')) throw new ForbiddenException('CASHIER_ASSIGNMENT_INVALID');
      const store = await tx.store.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id: ctx.storeId } });
      const now = new Date();
      const row = await tx.cashShift.create({ data: { ...scope(ctx), registerId: register.id, cashierId, openingAmount: input.openingAmount, businessDate: businessDate(now, store.dayStart, store.timezone), openedAt: now } });
      return { id: row.id, version: row.version };
    }, 'cashShift');
  }
  async move(ctx: Context, key: string, input: CashMovementCommand): Promise<Result> {
    return this.command(ctx, key, 'cash.movement.recorded', input, async (tx, current) => {
      const shift = await tx.cashShift.findFirst({ where: { ...scope(ctx), id: input.shiftId, status: 'OPEN' } });
      if (!shift) throw new ConflictException('SHIFT_NOT_OPEN');
      if (shift.cashierId !== current.userId && !allowed(current.role, 'admin')) throw new ForbiddenException('SHIFT_CASHIER_REQUIRED');
      await tx.$queryRaw`SELECT id FROM "CashShift" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${shift.id}::uuid FOR UPDATE`;
      const locked = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'OPEN', version: shift.version }, data: { version: { increment: 1 } } });
      if (locked.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
      if ((input.kind === 'REFUND') !== Boolean(input.paymentId)) throw new BadRequestException('REFUND_PAYMENT_REQUIRED');
      if (input.paymentId) {
        const payment = await tx.payment.findFirst({ where: { ...scope(ctx), id: input.paymentId, cashShiftId: shift.id } });
        if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
        const refunded = await tx.cashMovement.aggregate({ where: { ...scope(ctx), paymentId: payment.id, kind: 'REFUND' }, _sum: { amount: true } });
        if ((refunded._sum.amount ?? 0) + input.amount > payment.amount) throw new ConflictException('REFUND_EXCEEDS_PAYMENT');
      }
      const [payments, posted] = await Promise.all([
        tx.payment.aggregate({ where: { ...scope(ctx), cashShiftId: shift.id }, _sum: { amount: true } }),
        tx.cashMovement.findMany({ where: { ...scope(ctx), shiftId: shift.id } }),
      ]);
      try { cashExpected(shift.openingAmount, payments._sum.amount ?? 0, [...posted, input]); }
      catch { throw new ConflictException('CASH_BALANCE_OUT_OF_RANGE'); }
      const row = await tx.cashMovement.create({ data: { ...scope(ctx), shiftId: shift.id, commandKey: key, kind: input.kind, amount: input.amount, reason: input.reason, paymentId: input.paymentId, actorId: current.userId } });
      return { id: row.id, version: 1 };
    }, 'cash');
  }
  async close(ctx: Context, key: string, shiftId: string, input: CashShiftClose): Promise<Result> {
    return this.command(ctx, key, 'cash.shift.closing', { shiftId, ...input }, async (tx, current) => {
      const shift = await tx.cashShift.findFirst({ where: { ...scope(ctx), id: shiftId } });
      if (!shift) throw new NotFoundException('SHIFT_NOT_FOUND');
      if (shift.cashierId !== current.userId && !allowed(current.role, 'admin')) throw new ForbiddenException('SHIFT_CASHIER_REQUIRED');
      if (shift.status !== 'OPEN' || shift.version !== input.expectedVersion) throw new ConflictException('SHIFT_NOT_OPEN_OR_STALE');
      await tx.$queryRaw`SELECT id FROM "CashShift" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${shift.id}::uuid FOR UPDATE`;
      const payments = await tx.payment.aggregate({ where: { ...scope(ctx), cashShiftId: shift.id }, _sum: { amount: true } });
      const movements = await tx.cashMovement.findMany({ where: { ...scope(ctx), shiftId: shift.id } });
      let expected: number;
      try { expected = cashExpected(shift.openingAmount, payments._sum.amount ?? 0, movements); }
      catch { throw new ConflictException('INVALID_EXPECTED_CASH'); }
      const discrepancy = input.countedAmount - expected;
      if (discrepancy !== 0 && (!input.reason || input.reason.trim().length < 5)) throw new BadRequestException('DISCREPANCY_REASON_REQUIRED');
      const now = new Date();
      const pending = discrepancy !== 0;
      const updated = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'OPEN', version: input.expectedVersion }, data: { status: 'CLOSING', approvalStatus: pending ? 'PENDING' : 'NOT_REQUIRED', expectedAmount: expected, countedAmount: input.countedAmount, discrepancy, reason: pending ? input.reason : null, closingAt: now, version: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
      if (!pending) await tx.cashShift.update({ where: { id: shift.id }, data: { status: 'CLOSED', closedAt: now } });
      return { id: shift.id, version: shift.version + 1 };
    }, 'cashShift');
  }
  async approve(ctx: Context, key: string, shiftId: string, input: { expectedVersion: number; reason: string }): Promise<Result> {
    return this.command(ctx, key, 'cash.shift.approved', { shiftId, ...input }, async (tx, current) => {
      const shift = await tx.cashShift.findFirst({ where: { ...scope(ctx), id: shiftId, status: 'CLOSING', approvalStatus: 'PENDING' } });
      if (!shift) throw new NotFoundException('SHIFT_APPROVAL_NOT_FOUND');
      if (shift.version !== input.expectedVersion || shift.discrepancy === 0) throw new ConflictException('SHIFT_STALE');
      const now = new Date();
      const updated = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'CLOSING', version: input.expectedVersion }, data: { status: 'CLOSED', approvalStatus: 'APPROVED', approvedBy: current.userId, approvedAt: now, closedAt: now, version: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('SHIFT_APPROVAL_RACE');
      return { id: shift.id, version: shift.version + 1 };
    }, 'cashApprove');
  }
}
