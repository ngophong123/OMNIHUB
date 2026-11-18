import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ItemStatus, Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { CashCommand, CreateOrder, EventType, ItemCommand, StockCommand } from '@omnihub/contracts';
import { businessDate, digest, totalDue, transition, type Permission } from './domain';
import type { Context } from './auth';
import { CommandBus, scope, requirePermission, type Result, type Tx } from './commands';
import { composeRecipe, selectionPrice } from './catalog-domain';

export class Operations extends CommandBus {
  async accept(ctx: Context, key: string, body: CreateOrder): Promise<Result> {
    return this.command(ctx, key, 'order.accepted', body, tx => this.acceptTransaction(tx, ctx, key, body), 'pos');
  }

  async acceptFromTable(ctx: Context, key: string, body: CreateOrder, sessionId: string): Promise<Result & { trackingToken: string }> {
    const secret = process.env.QR_TOKEN_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'local-only-change-before-deployment');
    if (secret.length < 32) throw new Error('QR_TOKEN_SECRET_MUST_BE_CONFIGURED');
    const trackingToken = createHmac('sha256', secret).update(`${ctx.storeId}:${sessionId}:${key}`).digest('hex');
    const result = await this.publicCommand(ctx, key, 'order.accepted', { ...body, tableSessionId: sessionId }, async tx => {
      const session = await tx.tableSession.findFirst({ where: { ...scope(ctx), id: sessionId, sessionTokenHash: ctx.tokenHash, qrCredentialHash: { not: '' }, status: 'OPEN', expiresAt: { gt: new Date() }, table: { active: true, qrEnabled: true, store: { qrOrderingEnabled: true } } }, include: { table: true } });
      if (!session || session.qrCredentialHash !== session.table.qrTokenHash) throw new ForbiddenException('TABLE_SESSION_EXPIRED_OR_REVOKED');
      return this.acceptTransaction(tx, ctx, key, body, { sessionId, trackingTokenHash: digest(trackingToken) });
    });
    return { ...result, trackingToken };
  }

  private async acceptTransaction(tx: Tx, ctx: Context, key: string, body: CreateOrder, publicOrder?: { sessionId: string; trackingTokenHash: string }): Promise<Result> {
      const ids = [...new Set(body.lines.map(l => l.productId))];
      const products = await tx.product.findMany({ where: { ...scope(ctx), id: { in: ids }, active: true, deletedAt: null, manualAvailable: true, station: { active: true, deletedAt: null } }, include: { recipe: true, variants: { where: { active: true, deletedAt: null } }, modifierGroups: { where: { active: true, deletedAt: null }, include: { options: { where: { active: true, deletedAt: null }, include: { recipe: true } } } } } });
      if (products.length !== ids.length || products.some(p => p.recipe.length === 0)) throw new BadRequestException('PRODUCT_UNAVAILABLE_OR_NO_RECIPE');
      const units = body.lines.flatMap(line => {
        const p = products.find(product => product.id === line.productId)!;
        const variant = line.variantId ? p.variants.find(v => v.id === line.variantId) : undefined;
        if (line.variantId && !variant) throw new BadRequestException('VARIANT_UNAVAILABLE');
        const modifierIds = line.modifierIds ?? [];
        if (new Set(modifierIds).size !== modifierIds.length) throw new BadRequestException('DUPLICATE_MODIFIER');
        const selected = p.modifierGroups.flatMap(group => {
          const options = group.options.filter(option => modifierIds.includes(option.id));
          if (options.length < group.minSelections || options.length > group.maxSelections) throw new BadRequestException('MODIFIER_SELECTION_COUNT');
          return options;
        });
        if (selected.length !== modifierIds.length) throw new BadRequestException('MODIFIER_UNAVAILABLE');
        let price: number;
        let recipe: ReturnType<typeof composeRecipe>;
        try {
          price = selectionPrice(p.price, variant?.price, selected.map(option => option.priceDelta));
          recipe = composeRecipe(p.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) })), variant?.recipeMultiplier.toFixed(3) ?? '1.000', selected.flatMap(option => option.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) }))));
        } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INVALID_SELECTION'); }
        const optionNames = selected.map(option => option.name);
        const name = [p.name, variant?.name, ...optionNames].filter(Boolean).join(' · ');
        return Array.from({ length: line.quantity }, () => ({ product: p, variant, selected, price, recipe, name, note: line.note ?? '', selection: { variantId: variant?.id ?? null, variantName: variant?.name ?? null, modifiers: selected.map(o => ({ id: o.id, name: o.name, priceDelta: o.priceDelta })) } }));
      });
      if (units.length > 100) throw new BadRequestException('MAX_100_UNITS');
      let total: number;
      try { total = totalDue(units.map(u => ({ unitPrice: u.price, status: 'PENDING' }))); }
      catch { throw new BadRequestException('TOTAL_LIMIT'); }
      const needs = new Map<string, Prisma.Decimal>();
      for (const u of units) for (const r of u.recipe) needs.set(r.ingredientId, (needs.get(r.ingredientId) ?? new Prisma.Decimal(0)).add(r.quantity));
      for (const [ingredientId, quantity] of [...needs].sort(([a], [b]) => a.localeCompare(b))) {
        const changed = await tx.$executeRaw`UPDATE "Balance" SET "reserved" = "reserved" + ${quantity}::numeric WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "ingredientId" = ${ingredientId}::uuid AND "onHand" - "reserved" >= ${quantity}::numeric`;
        if (changed !== 1) throw new ConflictException('INSUFFICIENT_STOCK');
      }
      const order = await tx.order.create({ data: { ...scope(ctx), total, ...(publicOrder ? { channel: 'QR', tableSessionId: publicOrder.sessionId, trackingTokenHash: publicOrder.trackingTokenHash } : {}) } });
      const tickets = new Map<string, string>();
      for (const u of units) {
        const p = u.product;
        if (!tickets.has(p.stationId)) {
          const ticket = await tx.kitchenTicket.create({ data: { ...scope(ctx), orderId: order.id, stationId: p.stationId } });
          tickets.set(p.stationId, ticket.id);
        }
        const item = await tx.orderItem.create({ data: { ...scope(ctx), orderId: order.id, ticketId: tickets.get(p.stationId)!, productId: p.id, name: u.name, preparationNote: u.note, unitPrice: u.price, recipeVersion: p.recipeVersion, recipeSnapshot: u.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity })), selectionSnapshot: u.selection } });
        for (const r of u.recipe) {
          await tx.reservation.create({ data: { ...scope(ctx), itemId: item.id, ingredientId: r.ingredientId, quantity: r.quantity } });
          await tx.movement.create({ data: { ...scope(ctx), itemId: item.id, ingredientId: r.ingredientId, commandKey: key, kind: 'RESERVE', onHandDelta: 0, reservedDelta: r.quantity } });
        }
      }
      return { id: order.id, version: order.version };
  }

  async item(
    ctx: Context,
    key: string,
    itemId: string,
    body: ItemCommand,
    options?: { kitchenDeviceId?: string },
  ): Promise<Result> {
    const permission: Permission = body.action === 'START' || body.action === 'READY' ? 'kitchen' : body.action === 'HANDOFF' ? 'handoff' : 'cancelPending';
    const events: Record<ItemCommand['action'], EventType> = { START: 'kitchen.item.started', READY: 'kitchen.item.ready', HANDOFF: 'kitchen.item.handed_off', CANCEL: 'order.item.cancelled' };
    return this.command(ctx, key, events[body.action], { itemId, ...body }, async (tx, current) => {
      let authorizedStationId: string | null = null;
      if (options?.kitchenDeviceId) {
        const devices = await tx.$queryRaw<{ stationId: string | null }[]>`
          SELECT "stationId"
          FROM "KitchenDevice"
          WHERE "id" = ${options.kitchenDeviceId}::uuid
            AND "tenantId" = ${current.tenantId}::uuid
            AND "storeId" = ${current.storeId}::uuid
            AND "userId" = ${current.userId}::uuid
            AND "revokedAt" IS NULL
          FOR SHARE
        `;
        if (devices.length !== 1) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
        authorizedStationId = devices[0]!.stationId;
      }
      const item = await tx.orderItem.findFirst({ where: { ...scope(ctx), id: itemId }, include: { order: true, ticket: { select: { stationId: true } }, reservations: { orderBy: { ingredientId: 'asc' } } } });
      if (!item) throw new NotFoundException('ITEM_NOT_FOUND');
      if (authorizedStationId && item.ticket.stationId !== authorizedStationId) {
        throw new ForbiddenException('KITCHEN_COMMAND_SCOPE_MISMATCH');
      }
      const order = item.order;
      if (order.version !== body.expectedVersion || order.status !== 'ACCEPTED' || order.paymentStatus !== 'UNPAID') throw new ConflictException('STALE_OR_TERMINAL_ORDER');
      const activePayments = await tx.payment.count({ where: { ...scope(ctx), orderId: order.id, status: { in: ['PENDING','SETTLED'] } } });
      if (activePayments > 0) throw new ConflictException('ORDER_PAYMENT_IN_PROGRESS');
      const next = transition(item.status, body.action);
      if (!next) throw new ConflictException('INVALID_TRANSITION');
      if (body.action === 'CANCEL' && item.status !== 'PENDING') requirePermission(current, 'cancelStarted');
      const changed = await tx.order.updateMany({ where: { ...scope(ctx), id: order.id, version: body.expectedVersion }, data: { version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('STALE_VERSION');
      for (const r of item.reservations) {
        const balanceWhere = { tenantId_storeId_ingredientId: { ...scope(ctx), ingredientId: r.ingredientId } };
        if (body.action === 'START' || (body.action === 'CANCEL' && item.status === 'PENDING')) {
          if (r.status !== 'RESERVED') throw new ConflictException('RESERVATION_NOT_ACTIVE');
          const consume = body.action === 'START';
          await tx.balance.update({ where: balanceWhere, data: { reserved: { decrement: r.quantity }, ...(consume ? { onHand: { decrement: r.quantity } } : {}) } });
          await tx.reservation.update({ where: { id: r.id }, data: { status: consume ? 'CONSUMED' : 'RELEASED' } });
          await tx.movement.create({ data: { ...scope(ctx), itemId, ingredientId: r.ingredientId, commandKey: key, kind: consume ? 'CONSUME' : 'RELEASE', onHandDelta: consume ? r.quantity.negated() : 0, reservedDelta: r.quantity.negated() } });
        } else if (body.action === 'CANCEL') {
          if (r.status !== 'CONSUMED') throw new ConflictException('RESERVATION_NOT_CONSUMED');
          await tx.movement.create({ data: { ...scope(ctx), itemId, ingredientId: r.ingredientId, commandKey: key, kind: 'WASTE', onHandDelta: 0, reservedDelta: 0, wasteQuantity: r.quantity } });
        }
      }
      const now = new Date();
      await tx.orderItem.update({ where: { id: itemId }, data: { status: next as ItemStatus, ...(body.action === 'START' ? { startedAt: now } : body.action === 'READY' ? { readyAt: now } : body.action === 'HANDOFF' ? { handedOffAt: now } : { cancelledAt: now }) } });
      if (body.action === 'CANCEL') {
        const items = await tx.orderItem.findMany({ where: { ...scope(ctx), orderId: order.id } });
        await tx.order.update({ where: { id: order.id }, data: { total: totalDue(items), status: items.every(i => i.status === 'CANCELLED') ? 'CANCELLED' : 'ACCEPTED' } });
      }
      return { id: order.id, version: order.version + 1 };
    }, permission);
  }

  async cancelOrder(ctx: Context, key: string, orderId: string, input: { expectedVersion: number; reason: string }): Promise<Result> {
    return this.command(ctx, key, 'order.cancelled', { orderId, ...input }, async (tx, current) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: { include: { reservations: { orderBy: { ingredientId: 'asc' } } } } } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      if (order.status !== 'ACCEPTED' || order.paymentStatus !== 'UNPAID' || order.version !== input.expectedVersion) throw new ConflictException('ORDER_NOT_CANCELLABLE');
      const activePayments = await tx.payment.count({ where: { ...scope(ctx), orderId, status: { in: ['PENDING','SETTLED'] } } });
      if (activePayments > 0) throw new ConflictException('ORDER_PAYMENT_IN_PROGRESS');
      const started = order.items.some(item => item.status === 'PREPARING' || item.status === 'READY' || item.status === 'HANDED_OFF');
      if (started && !['OWNER','MANAGER'].includes(current.role)) throw new ForbiddenException('CANCEL_STARTED_REQUIRES_MANAGER');
      const now = new Date();
      for (const item of order.items) {
        if (item.status === 'CANCELLED') continue;
        for (const reservation of item.reservations) {
          if (reservation.status === 'RESERVED') {
            await tx.balance.update({ where: { tenantId_storeId_ingredientId: { ...scope(ctx), ingredientId: reservation.ingredientId } }, data: { reserved: { decrement: reservation.quantity } } });
            await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'RELEASED' } });
            await tx.movement.create({ data: { ...scope(ctx), itemId: item.id, ingredientId: reservation.ingredientId, commandKey: key, kind: 'RELEASE', onHandDelta: 0, reservedDelta: reservation.quantity.negated() } });
          } else if (reservation.status === 'CONSUMED') {
            await tx.movement.create({ data: { ...scope(ctx), itemId: item.id, ingredientId: reservation.ingredientId, commandKey: key, kind: 'WASTE', onHandDelta: 0, reservedDelta: 0, wasteQuantity: reservation.quantity, reason: input.reason } });
          }
        }
        await tx.orderItem.update({ where: { id: item.id }, data: { status: 'CANCELLED', cancelledAt: now } });
      }
      const changed = await tx.order.updateMany({ where: { ...scope(ctx), id: orderId, version: input.expectedVersion, status: 'ACCEPTED' }, data: { status: 'CANCELLED', total: 0, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('STALE_VERSION');
      return { id: orderId, version: order.version + 1 };
    }, 'cancelPending');
  }

  async cash(ctx: Context, key: string, orderId: string, body: CashCommand): Promise<Result> {
    return this.command(ctx, key, 'payment.confirmed', { orderId, ...body }, async tx => {
      const order = await tx.order.findFirst({ where: { ...scope(ctx), id: orderId }, include: { items: true, store: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      const live = order.items.filter(i => i.status !== 'CANCELLED');
      if (order.status !== 'ACCEPTED' || !['UNPAID','PARTIALLY_PAID'].includes(order.paymentStatus) || order.version !== body.expectedVersion || live.length === 0 || live.some(i => i.status !== 'HANDED_OFF')) throw new ConflictException('ORDER_NOT_PAYABLE');
      const total = totalDue(order.items);
      const prior = await tx.payment.aggregate({ where: { ...scope(ctx), orderId, status: { in: ['PENDING','SETTLED'] } }, _sum: { amount: true } });
      const pending = await tx.payment.count({ where: { ...scope(ctx), orderId, status: 'PENDING' } });
      if (pending > 0) throw new ConflictException('PAYMENT_VERIFICATION_PENDING');
      const amount = total - (prior._sum.amount ?? 0);
      if (amount <= 0 || body.tendered < amount) throw new BadRequestException('INSUFFICIENT_CASH');
      const [shift] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "CashShift" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "cashierId" = ${ctx.userId}::uuid AND status = 'OPEN' FOR UPDATE`;
      if (!shift) throw new ConflictException('OPEN_CASH_SHIFT_REQUIRED');
      const lockedShift = await tx.cashShift.updateMany({ where: { ...scope(ctx), id: shift.id, status: 'OPEN' }, data: { version: { increment: 1 } } });
      if (lockedShift.count !== 1) throw new ConflictException('SHIFT_CLOSE_RACE');
      await tx.payment.create({ data: { ...scope(ctx), orderId, cashierId: ctx.userId, cashShiftId: shift.id, amount, tendered: body.tendered, change: body.tendered - amount, status: 'SETTLED', idempotencyKey: key, businessDate: businessDate(new Date(), order.store.dayStart, order.store.timezone) } });
      const updated = await tx.order.updateMany({ where: { ...scope(ctx), id: orderId, version: body.expectedVersion, paymentStatus: { in: ['UNPAID','PARTIALLY_PAID'] } }, data: { total, paymentStatus: 'PAID', status: 'COMPLETED', version: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('STALE_VERSION');
      return { id: orderId, version: order.version + 1 };
    }, 'cash');
  }

  async adjust(ctx: Context, key: string, body: StockCommand): Promise<Result> {
    return this.command(ctx, key, 'inventory.adjusted', body, async tx => {
      const delta = new Prisma.Decimal(body.delta);
      if (delta.isZero() || delta.abs().gt('1000000000')) throw new BadRequestException('INVALID_ADJUSTMENT');
      const ingredient = await tx.ingredient.findFirst({ where: { ...scope(ctx), id: body.ingredientId, active: true, deletedAt: null } });
      if (!ingredient) throw new NotFoundException('INGREDIENT_NOT_FOUND');
      const changed = await tx.$executeRaw`UPDATE "Balance" SET "onHand" = "onHand" + ${delta}::numeric WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "ingredientId" = ${body.ingredientId}::uuid AND "onHand" + ${delta}::numeric >= "reserved"`;
      if (changed !== 1) throw new ConflictException('STOCK_BELOW_RESERVED_OR_NOT_FOUND');
      await tx.movement.create({ data: { ...scope(ctx), ingredientId: body.ingredientId, commandKey: key, kind: 'ADJUST', reason: body.reason, onHandDelta: delta, reservedDelta: 0 } });
      return { id: body.ingredientId, version: 0 };
    }, 'inventory');
  }
}
