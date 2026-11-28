import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { reauthorize, type Context } from './auth';
import type { Result } from './commands';
import { CommandBus, requirePermission, scope } from './commands';
import { allowed, businessDate, cashExpected, totalDue } from './domain';
import { LabeledCardSandboxAdapter, type CardProviderAdapter } from './card-provider';

type PaymentInput = { amount: number; method: 'CASH' | 'BANK_TRANSFER' | 'CARD'; tendered?: number; externalReference?: string; splitId?: string };
type RefundInput = { amount: number; reason: string; itemId?: string };
type RefundDecisionInput = { decision: 'APPROVED' | 'REJECTED'; reason: string; shiftId?: string };

export async function refreshOrderPaymentState(
  tx: Prisma.TransactionClient,
  ctx: Pick<Context, 'tenantId' | 'storeId'>,
  orderId: string,
  originalTotal?: number,
) {
  const [order, paid, refunds] = await Promise.all([
    tx.order.findFirstOrThrow({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId, id: orderId } }),
    tx.payment.aggregate({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId, orderId, status: 'SETTLED' }, _sum: { amount: true } }),
    tx.refund.aggregate({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId, orderId, status: 'APPROVED' }, _sum: { amount: true } }),
  ]);
  const total = originalTotal ?? order.total;
  const paidAmount = paid._sum.amount ?? 0;
  const refundedAmount = refunds._sum.amount ?? 0;
  const netPaid = Math.max(0, paidAmount - refundedAmount);
  const paymentStatus = refundedAmount >= paidAmount && refundedAmount > 0
    ? 'REFUNDED'
    : refundedAmount > 0
      ? 'PARTIALLY_REFUNDED'
      : netPaid >= total
        ? 'PAID'
        : paidAmount > 0
          ? 'PARTIALLY_PAID'
          : 'UNPAID';
  const orderStatus = netPaid >= total ? 'COMPLETED' : order.status === 'COMPLETED' ? 'COMPLETED' : 'ACCEPTED';
  await tx.order.update({ where: { id: orderId }, data: { paymentStatus, status: orderStatus, version: { increment: 1 } } });
}

export class Payments extends CommandBus {
  private readonly cardProvider: CardProviderAdapter;
  constructor(db: PrismaClient, cardProvider: CardProviderAdapter = new LabeledCardSandboxAdapter()) {
    super(db);
    this.cardProvider = cardProvider;
  }

  async history(ctx: Context, orderId: string) {
    if (!allowed(ctx.role, 'cash') && !allowed(ctx.role, 'report')) throw new ForbiddenException('PERMISSION_DENIED');
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
    const netPaid = Math.max(0, paid - refunded);
    return {
      payments,
      refunds,
      splits,
      total: order.total,
      paid,
      pending,
      refunded,
      outstanding: Math.max(0, order.total - netPaid),
      availableToCollect: Math.max(0, order.total - netPaid - pending),
    };
  }

  async record(ctx: Context, key: string, orderId: string, input: PaymentInput): Promise<Result> {
    requirePermission(ctx, 'cash');
    const authorized = await reauthorize(this.db, ctx);
    requirePermission(authorized, 'cash');
    if (input.method === 'CARD') await this.cardProvider.chargeCard(input.amount);
    if (input.method === 'BANK_TRANSFER' && !input.externalReference) throw new BadRequestException('BANK_REFERENCE_REQUIRED');
    if (input.method === 'CASH' && (input.tendered ?? 0) < input.amount) throw new BadRequestException('INSUFFICIENT_CASH');
    return this.command(ctx, key, input.method === 'BANK_TRANSFER' ? 'payment.recorded' : 'payment.confirmed', { orderId, ...input }, async (tx, current) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: true, store: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      const live = order.items.filter(i => i.status !== 'CANCELLED');
      if (order.status !== 'ACCEPTED' || order.paymentStatus === 'PAID' || live.length === 0 || live.some(i => i.status !== 'HANDED_OFF')) {
        throw new ConflictException('ORDER_NOT_PAYABLE');
      }
      const total = totalDue(order.items);
      const [settledAgg, pendingAgg, refundedAgg] = await Promise.all([
        tx.payment.aggregate({ where: { ...scope(ctx), orderId, status: 'SETTLED' }, _sum: { amount: true } }),
        tx.payment.aggregate({ where: { ...scope(ctx), orderId, status: 'PENDING' }, _sum: { amount: true } }),
        tx.refund.aggregate({ where: { ...scope(ctx), orderId, status: 'APPROVED' }, _sum: { amount: true } }),
      ]);
      const netSettled = Math.max(0, (settledAgg._sum.amount ?? 0) - (refundedAgg._sum.amount ?? 0));
      const pendingPaid = pendingAgg._sum.amount ?? 0;
      if (netSettled + pendingPaid + input.amount > total) throw new ConflictException('OVERPAYMENT_NOT_ALLOWED');
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
        const allocated = await tx.payment.aggregate({ where: { ...scope(ctx), splitId: split.id, status: { in: ['PENDING', 'SETTLED'] } }, _sum: { amount: true } });
        if ((allocated._sum.amount ?? 0) + input.amount > split.amount) throw new ConflictException('SPLIT_OVERALLOCATED');
      }
      const payment = await tx.payment.create({
        data: {
          ...scope(ctx),
          orderId,
          cashierId: current.userId,
          amount: input.amount,
          tendered: input.method === 'CASH' ? input.tendered! : input.amount,
          change: input.method === 'CASH' ? input.tendered! - input.amount : 0,
          method: input.method,
          status: input.method === 'CASH' ? 'SETTLED' : 'PENDING',
          externalReference: input.externalReference,
          idempotencyKey: key,
          splitId: input.splitId,
          cashShiftId: shiftId,
          businessDate: businessDate(new Date(), order.store.dayStart, order.store.timezone),
        },
      });
      if (input.method === 'CASH') await refreshOrderPaymentState(tx, ctx, orderId, order.total);
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
      const [settled, refunded] = await Promise.all([
        tx.payment.aggregate({ where: { ...scope(ctx), orderId: payment.orderId, status: 'SETTLED' }, _sum: { amount: true } }),
        tx.refund.aggregate({ where: { ...scope(ctx), orderId: payment.orderId, status: 'APPROVED' }, _sum: { amount: true } }),
      ]);
      const netSettled = Math.max(0, (settled._sum.amount ?? 0) - (refunded._sum.amount ?? 0));
      const total = totalDue(payment.order.items);
      if (netSettled + current.amount > total) throw new ConflictException('PAYMENT_EXCEEDS_ORDER_BALANCE');
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'SETTLED' } });
      await refreshOrderPaymentState(tx, ctx, payment.orderId, payment.order.total);
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
      await refreshOrderPaymentState(tx, ctx, payment.orderId);
      return { id: payment.id, version: 2 };
    }, 'cashApprove');
  }

  async split(ctx: Context, key: string, orderId: string, input: { label: string; amount?: number; itemIds?: string[] }): Promise<Result> {
    return this.command(ctx, key, 'payment.split.created', { orderId, ...input }, async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      if (order.status !== 'ACCEPTED') throw new ConflictException('ORDER_NOT_SPLITTABLE');
      const [rows, unallocatedPayments] = await Promise.all([
        tx.billSplit.findMany({ where: { ...scope(ctx), orderId } }),
        tx.payment.aggregate({ where: { ...scope(ctx), orderId, splitId: null, status: { in: ['PENDING', 'SETTLED'] } }, _sum: { amount: true } }),
      ]);
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
      const existingSplits = rows.reduce((n, r) => n + r.amount, 0);
      const unallocatedPaid = unallocatedPayments._sum.amount ?? 0;
      if (!amount || amount + existingSplits + unallocatedPaid > max) throw new ConflictException('SPLITS_EXCEED_ORDER_TOTAL');
      const split = await tx.billSplit.create({ data: { ...scope(ctx), orderId, label: input.label, amount, itemIds: input.itemIds ?? [], commandKey: key } });
      return { id: split.id, version: 1 };
    }, 'cash');
  }

  async requestRefund(ctx: Context, key: string, paymentId: string, input: RefundInput): Promise<Result> {
    return this.command(ctx, key, 'refund.requested', { paymentId, ...input }, async (tx, current) => {
      const paymentRef = await tx.payment.findFirst({ where: { ...scope(ctx), id: paymentId }, select: { id: true, orderId: true } });
      if (!paymentRef) throw new NotFoundException('SETTLED_PAYMENT_NOT_FOUND');
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${paymentRef.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${paymentId}::uuid FOR UPDATE`;
      const payment = await tx.payment.findFirst({
        where: { ...scope(ctx), id: paymentId, status: 'SETTLED' },
        include: { order: { include: { items: true, store: true } } },
      });
      if (!payment) throw new NotFoundException('SETTLED_PAYMENT_NOT_FOUND');
      if (input.itemId && !payment.order.items.some(i => i.id === input.itemId && i.status !== 'CANCELLED')) {
        throw new BadRequestException('REFUND_ITEM_INVALID');
      }
      if (input.itemId) {
        const item = payment.order.items.find(i => i.id === input.itemId)!;
        const itemRefunds = await tx.refund.aggregate({
          where: { ...scope(ctx), orderId: payment.orderId, itemId: input.itemId, status: { in: ['REQUESTED', 'APPROVED'] } },
          _sum: { amount: true },
        });
        if ((itemRefunds._sum.amount ?? 0) + input.amount > item.unitPrice) throw new ConflictException('ITEM_REFUND_EXCEEDS_PRICE');
      }
      const [sum, legacy] = await Promise.all([
        tx.refund.aggregate({ where: { ...scope(ctx), paymentId, status: { in: ['REQUESTED', 'APPROVED'] } }, _sum: { amount: true } }),
        tx.cashMovement.aggregate({ where: { ...scope(ctx), paymentId, kind: 'REFUND', refundId: null }, _sum: { amount: true } }),
      ]);
      if ((sum._sum.amount ?? 0) + (legacy._sum.amount ?? 0) + input.amount > payment.amount) {
        throw new ConflictException('REFUND_EXCEEDS_PAYMENT');
      }
      const refund = await tx.refund.create({
        data: {
          ...scope(ctx),
          orderId: payment.orderId,
          paymentId,
          itemId: input.itemId,
          amount: input.amount,
          reason: input.reason,
          requestedBy: current.userId,
          commandKey: key,
          businessDate: businessDate(new Date(), payment.order.store.dayStart, payment.order.store.timezone),
        },
      });
      return { id: refund.id, version: 1 };
    }, 'cash');
  }

  async decideRefund(ctx: Context, key: string, refundId: string, input: RefundDecisionInput): Promise<Result> {
    return this.command(ctx, key, 'refund.decided', { refundId, ...input }, async (tx, current) => {
      const refundRef = await tx.refund.findFirst({
        where: { ...scope(ctx), id: refundId },
        select: { id: true, orderId: true, paymentId: true },
      });
      if (!refundRef) throw new NotFoundException('REFUND_NOT_FOUND');
      // Strict deterministic lock order: Order -> Payment -> Refund -> CashShift.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${refundRef.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${refundRef.paymentId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Refund" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${refundId}::uuid FOR UPDATE`;
      const refund = await tx.refund.findFirst({ where: { ...scope(ctx), id: refundId }, include: { payment: true } });
      if (!refund) throw new NotFoundException('REFUND_NOT_FOUND');
      if (refund.status !== 'REQUESTED') throw new ConflictException('REFUND_ALREADY_DECIDED');
      if (refund.payment.status !== 'SETTLED') throw new ConflictException('PAYMENT_NOT_SETTLED');
      if (input.shiftId && (input.decision !== 'APPROVED' || refund.payment.method !== 'CASH')) {
        throw new BadRequestException('SHIFT_ONLY_FOR_CASH_REFUND');
      }

      let shiftId: string | null = null;
      if (input.decision === 'APPROVED' && refund.payment.method === 'CASH') {
        let lockedShift: { id: string; cashierId: string; status: string; openingAmount: number } | undefined;
        if (input.shiftId) {
          const [selected] = await tx.$queryRaw<{ id: string; cashierId: string; status: string; openingAmount: number }[]>`
            SELECT id, "cashierId", status, "openingAmount"
            FROM "CashShift"
            WHERE "tenantId" = ${current.tenantId}::uuid
              AND "storeId" = ${current.storeId}::uuid
              AND id = ${input.shiftId}::uuid
            FOR UPDATE
          `;
          if (!selected) throw new NotFoundException('SHIFT_NOT_FOUND');
          if (selected.status !== 'OPEN') throw new ConflictException('SHIFT_NOT_OPEN');
          const ownerMembership = await tx.membership.findUnique({
            where: { userId_storeId: { userId: selected.cashierId, storeId: current.storeId } },
            include: { user: { select: { active: true } } },
          });
          if (!ownerMembership || ownerMembership.tenantId !== current.tenantId || !ownerMembership.user.active || !allowed(ownerMembership.role, 'cashShift')) {
            throw new ForbiddenException('SHIFT_OWNER_INVALID');
          }
          lockedShift = selected;
        } else {
          // Never silently pick another cashier's shift; only the approving manager's own open shift is implicit.
          const [ownShift] = await tx.$queryRaw<{ id: string; cashierId: string; status: string; openingAmount: number }[]>`
            SELECT id, "cashierId", status, "openingAmount"
            FROM "CashShift"
            WHERE "tenantId" = ${current.tenantId}::uuid
              AND "storeId" = ${current.storeId}::uuid
              AND "cashierId" = ${current.userId}::uuid
              AND status = 'OPEN'
            FOR UPDATE
          `;
          if (!ownShift) throw new ConflictException('OPEN_CASH_SHIFT_REQUIRED_FOR_CASH_REFUND');
          lockedShift = ownShift;
        }

        const [shiftPayments, shiftMovements] = await Promise.all([
          tx.payment.aggregate({ where: { ...scope(ctx), cashShiftId: lockedShift.id, status: 'SETTLED' }, _sum: { amount: true } }),
          tx.cashMovement.findMany({ where: { ...scope(ctx), shiftId: lockedShift.id } }),
        ]);
        try {
          cashExpected(lockedShift.openingAmount, shiftPayments._sum.amount ?? 0, [
            ...shiftMovements,
            { kind: 'REFUND', amount: refund.amount },
          ]);
        } catch {
          throw new ConflictException('CASH_BALANCE_OUT_OF_RANGE');
        }

        const bumped = await tx.cashShift.updateMany({
          where: { ...scope(ctx), id: lockedShift.id, status: 'OPEN' },
          data: { version: { increment: 1 } },
        });
        if (bumped.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
        shiftId = lockedShift.id;
      }

      if (input.decision === 'APPROVED') {
        const [sum, legacy] = await Promise.all([
          tx.refund.aggregate({ where: { ...scope(ctx), paymentId: refund.paymentId, status: 'APPROVED' }, _sum: { amount: true } }),
          tx.cashMovement.aggregate({ where: { ...scope(ctx), paymentId: refund.paymentId, kind: 'REFUND', refundId: null }, _sum: { amount: true } }),
        ]);
        if ((sum._sum.amount ?? 0) + (legacy._sum.amount ?? 0) + refund.amount > refund.payment.amount) {
          throw new ConflictException('REFUND_EXCEEDS_PAYMENT');
        }
        if (refund.payment.method === 'CASH') {
          await tx.cashMovement.create({
            data: {
              ...scope(ctx),
              shiftId: shiftId!,
              commandKey: `${key}:cash`,
              kind: 'REFUND',
              amount: refund.amount,
              reason: refund.reason,
              paymentId: refund.paymentId,
              refundId: refund.id,
              actorId: current.userId,
            },
          });
        }
      }
      await tx.refundDecision.create({
        data: { ...scope(ctx), refundId, actorId: current.userId, decision: input.decision, reason: input.reason },
      });
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: input.decision, approvedBy: current.userId, approvedAt: new Date() },
      });
      if (input.decision === 'APPROVED') await refreshOrderPaymentState(tx, ctx, refund.orderId, undefined);
      return { id: refund.id, version: 2 };
    }, 'cashApprove');
  }
}
