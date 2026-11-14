import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Context } from './auth';
import type { Result } from './commands';
import { CommandBus, scope } from './commands';
import { businessDate, totalDue } from './domain';
import { LabeledCardSandboxAdapter } from './card-provider';

type PaymentInput = { amount: number; method: 'CASH' | 'BANK_TRANSFER' | 'CARD'; tendered?: number; externalReference?: string; splitId?: string };
type RefundInput = { amount: number; reason: string; itemId?: string };

export class Payments extends CommandBus {
  private readonly cardProvider = new LabeledCardSandboxAdapter();
  async history(ctx: Context, orderId: string) {
    const order = await this.db.order.findFirst({ where: { ...scope(ctx), id: orderId }, select: { id: true, total: true } });
    if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
    const [payments, refunds, splits] = await Promise.all([
      this.db.payment.findMany({ where: { ...scope(ctx), orderId }, orderBy: { createdAt: 'asc' }, include: { refunds: true } }),
      this.db.refund.findMany({ where: { ...scope(ctx), orderId }, include: { decisions: true }, orderBy: { createdAt: 'asc' } }),
      this.db.billSplit.findMany({ where: { ...scope(ctx), orderId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const paid = payments.filter(p => p.status === 'SETTLED').reduce((n, p) => n + p.amount, 0);
    const pending = payments.filter(p => p.status === 'PENDING').reduce((n, p) => n + p.amount, 0);
    const refunded = refunds.filter(r => r.status === 'APPROVED').reduce((n, r) => n + r.amount, 0);
    return { payments, refunds, splits, total: order.total, paid, pending, refunded, outstanding: Math.max(0, order.total - paid), availableToCollect: Math.max(0, order.total - paid - pending) };
  }

  async record(ctx: Context, key: string, orderId: string, input: PaymentInput): Promise<Result> {
    if (input.method === 'CARD') await this.cardProvider.authorize(input.amount);
    if (input.method === 'BANK_TRANSFER' && !input.externalReference) throw new BadRequestException('BANK_REFERENCE_REQUIRED');
    if (input.method === 'CASH' && (input.tendered ?? 0) < input.amount) throw new BadRequestException('INSUFFICIENT_CASH');
    return this.command(ctx, key, input.method === 'BANK_TRANSFER' ? 'payment.recorded' : 'payment.confirmed', { orderId, ...input }, async (tx, current) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: true, store: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      const live = order.items.filter(i => i.status !== 'CANCELLED');
      if (order.status !== 'ACCEPTED' || ['PAID','PARTIALLY_REFUNDED','REFUNDED'].includes(order.paymentStatus) || live.length === 0 || live.some(i => i.status !== 'HANDED_OFF')) throw new ConflictException('ORDER_NOT_PAYABLE');
      const total = totalDue(order.items);
      const existing = await tx.payment.aggregate({ where: { ...scope(ctx), orderId, status: { in: ['PENDING','SETTLED'] } }, _sum: { amount: true } });
      const pendingPaid = existing._sum.amount ?? 0;
      if (pendingPaid + input.amount > total) throw new ConflictException('OVERPAYMENT_NOT_ALLOWED');
      let shiftId: string | null = null;
      if (input.method === 'CASH') {
        const [shift] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "CashShift" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "cashierId" = ${current.userId}::uuid AND status = 'OPEN' FOR UPDATE`;
        if (!shift) throw new ConflictException('OPEN_CASH_SHIFT_REQUIRED');
        const locked = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'OPEN' }, data: { version: { increment: 1 } } });
        if (locked.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
        shiftId = shift.id;
      }
      if (input.splitId) {
        const split = await tx.billSplit.findFirst({ where: { ...scope(ctx), id: input.splitId, orderId } });
        if (!split) throw new NotFoundException('BILL_SPLIT_NOT_FOUND');
        const allocated = await tx.payment.aggregate({ where: { ...scope(ctx), splitId: split.id, status: { in: ['PENDING','SETTLED'] } }, _sum: { amount: true } });
        if ((allocated._sum.amount ?? 0) + input.amount > split.amount) throw new ConflictException('SPLIT_OVERALLOCATED');
      }
      const payment = await tx.payment.create({ data: { ...scope(ctx), orderId, cashierId: current.userId, amount: input.amount, tendered: input.method === 'CASH' ? input.tendered! : input.amount, change: input.method === 'CASH' ? input.tendered! - input.amount : 0, method: input.method, status: input.method === 'CASH' ? 'SETTLED' : 'PENDING', externalReference: input.externalReference, idempotencyKey: key, splitId: input.splitId, cashShiftId: shiftId, businessDate: businessDate(new Date(), order.store.dayStart, order.store.timezone) } });
      if (input.method === 'CASH') await this.refreshOrder(tx, ctx, orderId, order.total);
      return { id: payment.id, version: 1 };
    }, 'cash');
  }

  async verify(ctx: Context, key: string, paymentId: string): Promise<Result> {
    return this.command(ctx, key, 'payment.verified', { paymentId }, async tx => {
      const payment = await tx.payment.findFirst({ where: { ...scope(ctx), id: paymentId }, include: { order: { include: { items: true } } } });
      if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
      if (payment.method !== 'BANK_TRANSFER' || payment.status !== 'PENDING') throw new ConflictException('PAYMENT_NOT_VERIFIABLE');
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${payment.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${payment.id}::uuid FOR UPDATE`;
      const current = await tx.payment.findFirst({ where: { ...scope(ctx), id: payment.id } });
      if (!current || current.status !== 'PENDING') throw new ConflictException('PAYMENT_NOT_VERIFIABLE');
      const settled = await tx.payment.aggregate({ where: { ...scope(ctx), orderId: payment.orderId, status: 'SETTLED' }, _sum: { amount: true } });
      const total = totalDue(payment.order.items);
      if ((settled._sum.amount ?? 0) + current.amount > total) throw new ConflictException('PAYMENT_EXCEEDS_ORDER_BALANCE');
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'SETTLED' } });
      await this.refreshOrder(tx, ctx, payment.orderId, payment.order.total);
      return { id: payment.id, version: 2 };
    }, 'cashApprove');
  }

  async failPending(ctx: Context, key: string, paymentId: string, reason: string): Promise<Result> {
    return this.command(ctx, key, 'payment.failed', { paymentId, reason }, async tx => {
      const payment = await tx.payment.findFirst({ where: { ...scope(ctx), id: paymentId } });
      if (!payment) throw new NotFoundException('PAYMENT_NOT_FOUND');
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${payment.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${payment.id}::uuid FOR UPDATE`;
      const current = await tx.payment.findFirst({ where: { ...scope(ctx), id: payment.id } });
      if (!current || current.method !== 'BANK_TRANSFER' || current.status !== 'PENDING') throw new ConflictException('PAYMENT_NOT_FAILABLE');
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      await this.refreshOrder(tx, ctx, payment.orderId);
      return { id: payment.id, version: 2 };
    }, 'cashApprove');
  }

  async split(ctx: Context, key: string, orderId: string, input: { label: string; amount?: number; itemIds?: string[] }): Promise<Result> {
    return this.command(ctx, key, 'payment.split.created', { orderId, ...input }, async tx => {
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      if (order.status !== 'ACCEPTED') throw new ConflictException('ORDER_NOT_SPLITTABLE');
      const rows = await tx.billSplit.findMany({ where: { ...scope(ctx), orderId } });
      let amount = input.amount;
      if (input.itemIds) {
        if (new Set(input.itemIds).size !== input.itemIds.length) throw new BadRequestException('DUPLICATE_SPLIT_ITEM');
        const items = order.items.filter(i => input.itemIds!.includes(i.id) && i.status !== 'CANCELLED');
        if (items.length !== input.itemIds.length) throw new BadRequestException('SPLIT_ITEM_INVALID');
        const already = new Set(rows.flatMap(r => Array.isArray(r.itemIds) ? r.itemIds as string[] : []));
        if (input.itemIds.some(id => already.has(id))) throw new ConflictException('SPLIT_ITEM_ALREADY_ALLOCATED');
        amount = items.reduce((sum, item) => sum + item.unitPrice, 0);
      }
      const max = totalDue(order.items);
      if (!amount || amount + rows.reduce((n, r) => n + r.amount, 0) > max) throw new ConflictException('SPLITS_EXCEED_ORDER_TOTAL');
      const split = await tx.billSplit.create({ data: { ...scope(ctx), orderId, label: input.label, amount, itemIds: input.itemIds ?? [], commandKey: key } });
      return { id: split.id, version: 1 };
    }, 'cash');
  }

  async requestRefund(ctx: Context, key: string, paymentId: string, input: RefundInput): Promise<Result> {
    return this.command(ctx, key, 'refund.requested', { paymentId, ...input }, async tx => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${paymentId}::uuid FOR UPDATE`;
      const payment = await tx.payment.findFirst({ where: { ...scope(ctx), id: paymentId, status: 'SETTLED' }, include: { order: { include: { items: true, store: true } } } });
      if (!payment) throw new NotFoundException('SETTLED_PAYMENT_NOT_FOUND');
      if (input.itemId && !payment.order.items.some(i => i.id === input.itemId && i.status !== 'CANCELLED')) throw new BadRequestException('REFUND_ITEM_INVALID');
      if (input.itemId) {
        const item = payment.order.items.find(i => i.id === input.itemId)!;
        const itemRefunds = await tx.refund.aggregate({ where: { ...scope(ctx), orderId: payment.orderId, itemId: input.itemId, status: { in: ['REQUESTED','APPROVED'] } }, _sum: { amount: true } });
        if ((itemRefunds._sum.amount ?? 0) + input.amount > item.unitPrice) throw new ConflictException('ITEM_REFUND_EXCEEDS_PRICE');
      }
      const sum = await tx.refund.aggregate({ where: { ...scope(ctx), paymentId, status: { in: ['REQUESTED','APPROVED'] } }, _sum: { amount: true } });
      const legacy = await tx.cashMovement.aggregate({ where: { ...scope(ctx), paymentId, kind: 'REFUND', refundId: null }, _sum: { amount: true } });
      if ((sum._sum.amount ?? 0) + (legacy._sum.amount ?? 0) + input.amount > payment.amount) throw new ConflictException('REFUND_EXCEEDS_PAYMENT');
      const refund = await tx.refund.create({ data: { ...scope(ctx), orderId: payment.orderId, paymentId, itemId: input.itemId, amount: input.amount, reason: input.reason, requestedBy: ctx.userId, commandKey: key, businessDate: businessDate(new Date(), payment.order.store.dayStart, payment.order.store.timezone) } });
      return { id: refund.id, version: 1 };
    }, 'cash');
  }

  async decideRefund(ctx: Context, key: string, refundId: string, input: { decision: 'APPROVED'|'REJECTED'; reason: string }): Promise<Result> {
    return this.command(ctx, key, 'refund.decided', { refundId, ...input }, async (tx, current) => {
      await tx.$queryRaw`SELECT id FROM "Refund" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${refundId}::uuid FOR UPDATE`;
      const refund = await tx.refund.findFirst({ where: { ...scope(ctx), id: refundId }, include: { payment: true } });
      if (!refund) throw new NotFoundException('REFUND_NOT_FOUND');
      if (refund.status !== 'REQUESTED') throw new ConflictException('REFUND_ALREADY_DECIDED');
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${refund.paymentId}::uuid FOR UPDATE`;
      let shiftId: string | null = null;
      if (input.decision === 'APPROVED' && refund.payment.method === 'CASH') {
        const [shift] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "CashShift" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "cashierId" = ${current.userId}::uuid AND status = 'OPEN' FOR UPDATE`;
        if (!shift) throw new ConflictException('OPEN_CASH_SHIFT_REQUIRED_FOR_CASH_REFUND');
        const locked = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'OPEN' }, data: { version: { increment: 1 } } });
        if (locked.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
        shiftId = shift.id;
      }
      if (input.decision === 'APPROVED') {
        const [sum, legacy] = await Promise.all([
          tx.refund.aggregate({ where: { ...scope(ctx), paymentId: refund.paymentId, status: 'APPROVED' }, _sum: { amount: true } }),
          tx.cashMovement.aggregate({ where: { ...scope(ctx), paymentId: refund.paymentId, kind: 'REFUND', refundId: null }, _sum: { amount: true } }),
        ]);
        if ((sum._sum.amount ?? 0) + (legacy._sum.amount ?? 0) + refund.amount > refund.payment.amount) throw new ConflictException('REFUND_EXCEEDS_PAYMENT');
        if (refund.payment.method === 'CASH') await tx.cashMovement.create({ data: { ...scope(ctx), shiftId: shiftId!, commandKey: `${key}:cash`, kind: 'REFUND', amount: refund.amount, reason: refund.reason, paymentId: refund.paymentId, refundId: refund.id, actorId: current.userId } });
      }
      await tx.refundDecision.create({ data: { ...scope(ctx), refundId, actorId: current.userId, decision: input.decision, reason: input.reason } });
      await tx.refund.update({ where: { id: refund.id }, data: { status: input.decision, approvedBy: current.userId, approvedAt: new Date() } });
      if (input.decision === 'APPROVED') await this.refreshOrder(tx, ctx, refund.orderId, undefined);
      return { id: refund.id, version: 2 };
    }, 'cashApprove');
  }

  private async refreshOrder(tx: Prisma.TransactionClient, ctx: Context, orderId: string, originalTotal?: number) {
    const [order, paid, refunds] = await Promise.all([
      tx.order.findFirstOrThrow({ where: { ...scope(ctx), id: orderId } }),
      tx.payment.aggregate({ where: { ...scope(ctx), orderId, status: 'SETTLED' }, _sum: { amount: true } }),
      tx.refund.aggregate({ where: { ...scope(ctx), orderId, status: 'APPROVED' }, _sum: { amount: true } }),
    ]);
    const total = originalTotal ?? order.total;
    const paidAmount = paid._sum.amount ?? 0;
    const refundedAmount = refunds._sum.amount ?? 0;
    const status = refundedAmount >= paidAmount && refundedAmount > 0 ? 'REFUNDED' : refundedAmount > 0 ? 'PARTIALLY_REFUNDED' : paidAmount >= total ? 'PAID' : paidAmount > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
    const orderStatus = paidAmount >= total ? 'COMPLETED' : order.status === 'COMPLETED' ? 'COMPLETED' : 'ACCEPTED';
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: status, status: orderStatus, version: { increment: 1 } } });
  }
}
