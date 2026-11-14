import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { Operations } from '../../apps/api/src/operations';
import { CatalogOperations } from '../../apps/api/src/catalog-operations';
import { CashShifts } from '../../apps/api/src/cash-shifts';
import { Payments } from '../../apps/api/src/payments';
import { QrOrdering } from '../../apps/api/src/qr-ordering';
import { PilotAdmin } from '../../apps/api/src/pilot-admin';
import { authenticate, type Context } from '../../apps/api/src/auth';
import { digest } from '../../apps/api/src/domain';

const db = new PrismaClient(); const ops = new Operations(db);
const catalog = new CatalogOperations(db);
const cashShifts = new CashShifts(db);
const paymentOps = new Payments(db);
const qrOps = new QrOrdering(db);
const pilotAdmin = new PilotAdmin(db);
afterAll(() => db.$disconnect());
async function fixture(stock = '100') {
  const tenantId = randomUUID(); const storeId = randomUUID(); const userId = randomUUID(); const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''); const tokenHash = digest(token);
  const data = await db.$transaction(async tx => {
    await tx.tenant.create({ data: { id: tenantId, name: 'Integration fixture' } });
    await tx.store.create({ data: { id: storeId, tenantId, name: 'Isolated test store' } });
    await tx.user.create({ data: { id: userId, email: `${userId}@test.invalid`, passwordHash: 'not-a-login-fixture' } });
    await tx.membership.create({ data: { userId, tenantId, storeId, role: 'OWNER' } });
    await tx.session.create({ data: { tenantId, storeId, userId, tokenHash, expiresAt: new Date(Date.now() + 3600_000) } });
    const station = await tx.station.create({ data: { tenantId, storeId, name: 'Test station' } });
    const ingredients = [];
    for (const name of ['Coffee', 'Milk']) {
      const i = await tx.ingredient.create({ data: { tenantId, storeId, name, unit: 'g' } }); ingredients.push(i);
      await tx.balance.create({ data: { tenantId, storeId, ingredientId: i.id, onHand: stock } });
      await tx.movement.create({ data: { tenantId, storeId, ingredientId: i.id, commandKey: 'fixture', kind: 'ADJUST', reason: 'Test opening stock', onHandDelta: stock, reservedDelta: 0 } });
    }
    const product = await tx.product.create({ data: { tenantId, storeId, stationId: station.id, name: 'Snapshot coffee', price: 35000 } });
    for (const i of ingredients) await tx.recipeItem.create({ data: { tenantId, storeId, productId: product.id, ingredientId: i.id, quantity: '10' } });
    return { product, ingredients };
  });
  const ctx: Context = { tenantId, storeId, userId, tokenHash, role: 'OWNER', expiresAt: new Date(Date.now() + 3600_000), correlationId: randomUUID() };
  return { ...data, ctx, token, body: { lines: [{ productId: data.product.id, quantity: 1 }] } };
}
const getOrder = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
async function advance(c: Context, orderId: string, action: 'START' | 'READY' | 'HANDOFF') {
  const o = await getOrder(orderId); const item = o.items.find(i => i.status !== 'CANCELLED')!;
  return ops.item(c, randomUUID(), item.id, { action, expectedVersion: o.version });
}
async function openShift(ctx: Context, openingAmount = 0) {
  const register = await db.cashRegister.findFirstOrThrow({ where: { tenantId: ctx.tenantId, storeId: ctx.storeId } });
  return cashShifts.open(ctx, randomUUID(), { registerId: register.id, openingAmount });
}

describe('real PostgreSQL vertical slice and integrity', () => {
  it('accepts QR orders through the POS reservation and ticket transaction, with revocable credentials and order-only tracking', async () => {
    const f = await fixture();
    await db.store.update({ where: { id: f.ctx.storeId }, data: { qrOrderingEnabled: true } });
    const category = await db.category.create({ data: { tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, name: 'Drinks' } });
    await db.product.update({ where: { id: f.product.id }, data: { categoryId: category.id, imageUrl: 'https://images.example.test/coffee.jpg' } });
    const variant = await catalog.saveVariant(f.ctx, randomUUID(), f.product.id, undefined, undefined, { name: 'Large', active: true, price: 40_000, recipeMultiplier: '1' });
    const group = await catalog.saveGroup(f.ctx, randomUUID(), f.product.id, undefined, undefined, { name: 'Add-on', active: true, minSelections: 1, maxSelections: 1 });
    const option = await catalog.saveModifier(f.ctx, randomUUID(), group.id, undefined, undefined, { name: 'Extra coffee', active: true, priceDelta: 5_000, recipe: [{ ingredientId: f.ingredients[0]!.id, quantity: '5', unit: 'g' }] });
    const table = await qrOps.createTable(f.ctx, randomUUID(), 'Table 7');
    expect(table.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.restaurantTable.findUniqueOrThrow({ where: { id: table.id } })).toMatchObject({ qrTokenHash: digest(table.token), name: 'Table 7' });
    const menu = await qrOps.publicMenu(table.token);
    expect(menu).toMatchObject({ restaurant: { name: 'Isolated test store' }, table: { name: 'Table 7' }, categories: [{ name: 'Drinks' }], products: [{ name: 'Snapshot coffee', imageUrl: 'https://images.example.test/coffee.jpg', available: true, variants: [{ id: variant.id, price: 40_000, available: true }], modifierGroups: [{ options: [{ id: option.id, priceDelta: 5_000, available: true }] }] }] });
    const session = await qrOps.openCustomerSession(table.token);
    const sessionRow = await db.tableSession.findUniqueOrThrow({ where: { sessionTokenHash: digest(session.token) } });
    const publicCtx: Context = { ...f.ctx, userId: sessionRow.id, tokenHash: sessionRow.sessionTokenHash };
    const otherStore = await fixture();
    await expect(qrOps.updateTable(otherStore.ctx, randomUUID(), table.id, table.version, 'Other store table', true, true)).rejects.toThrow('TABLE_NOT_FOUND');
    const key = randomUUID();
    const lines = [{ productId: f.product.id, quantity: 2, variantId: variant.id, modifierIds: [option.id], note: 'No ice' }];
    const accepted = await ops.acceptFromTable(publicCtx, key, { lines }, sessionRow.id);
    const retried = await ops.acceptFromTable(publicCtx, key, { lines }, sessionRow.id);
    expect(retried).toEqual(accepted);
    expect(accepted.trackingToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await getOrder(accepted.id)).toMatchObject({ channel: 'QR', tableSessionId: sessionRow.id, items: [{ unitPrice: 45_000, preparationNote: 'No ice' }, { unitPrice: 45_000, preparationNote: 'No ice' }] });
    expect(await db.kitchenTicket.count({ where: { orderId: accepted.id } })).toBe(1);
    expect(await db.reservation.count({ where: { item: { orderId: accepted.id } } })).toBe(4);
    expect(await db.movement.count({ where: { commandKey: key, kind: 'RESERVE' } })).toBe(4);
    expect(await qrOps.status(accepted.trackingToken)).toMatchObject({ id: accepted.id, status: 'ACCEPTED', restaurant: 'Isolated test store', table: 'Table 7', items: [{ name: 'Snapshot coffee · Large · Extra coffee' }, { name: 'Snapshot coffee · Large · Extra coffee' }] });
    await expect(qrOps.status(randomUUID().replaceAll('-', '').padEnd(64, '0'))).rejects.toThrow('TRACKING_NOT_FOUND');
    await qrOps.regenerate(f.ctx, randomUUID(), table.id, table.version);
    await expect(qrOps.publicMenu(table.token)).rejects.toThrow('TABLE_QR_UNAVAILABLE');
    await expect(qrOps.validateCustomerSession(session.token)).rejects.toThrow('TABLE_SESSION_EXPIRED_OR_REVOKED');
  });

  it('serializes simultaneous QR reservations for the last available recipe stock', async () => {
    const f = await fixture('10'); await db.store.update({ where: { id: f.ctx.storeId }, data: { qrOrderingEnabled: true } });
    const table = await qrOps.createTable(f.ctx, randomUUID(), 'Race table');
    const sessions = await Promise.all([qrOps.openCustomerSession(table.token), qrOps.openCustomerSession(table.token)]);
    const attempts = await Promise.allSettled(sessions.map(async session => {
      const row = await db.tableSession.findUniqueOrThrow({ where: { sessionTokenHash: digest(session.token) } });
      const publicCtx: Context = { ...f.ctx, userId: row.id, tokenHash: row.sessionTokenHash };
      return ops.acceptFromTable(publicCtx, randomUUID(), f.body, row.id);
    }));
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await db.order.count({ where: { storeId: f.ctx.storeId, channel: 'QR' } })).toBe(1);
    for (const balance of await db.balance.findMany({ where: { storeId: f.ctx.storeId } })) expect(balance.onHand.sub(balance.reserved).toNumber()).toBe(0);
  });

  it('cancels an unpaid order atomically, releasing pending stock and recording consumed stock as waste', async () => {
    const f = await fixture();
    const accepted = await ops.accept(f.ctx, randomUUID(), { lines: [{ productId: f.product.id, quantity: 2 }] });
    const order = await getOrder(accepted.id);
    await ops.item(f.ctx, randomUUID(), order.items[0]!.id, { action: 'START', expectedVersion: order.version });
    const current = await getOrder(accepted.id);
    await ops.cancelOrder(f.ctx, randomUUID(), accepted.id, { expectedVersion: current.version, reason: 'Customer requested order cancellation' });
    expect(await db.order.findUniqueOrThrow({ where: { id: accepted.id } })).toMatchObject({ status: 'CANCELLED', total: 0 });
    expect(await db.balance.findMany({ where: { storeId: f.ctx.storeId } })).toHaveLength(2);
    for (const balance of await db.balance.findMany({ where: { storeId: f.ctx.storeId } })) { expect(balance.onHand.toNumber()).toBe(90); expect(balance.reserved.toNumber()).toBe(0); }
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, kind: 'WASTE' } })).toBe(2);
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, kind: 'RELEASE' } })).toBe(2);
    expect(await db.payment.count({ where: { orderId: accepted.id } })).toBe(0);
  });
  it('supports split allocations, partial cash and verified bank transfer without duplicating kitchen or stock work', async () => {
    const f = await fixture(); await openShift(f.ctx);
    const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const split = await paymentOps.split(f.ctx, randomUUID(), accepted.id, { label: 'Payer one', amount: 15_000 });
    const cash = await paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'CASH', amount: 15_000, tendered: 15_000, splitId: split.id });
    expect((await db.order.findUniqueOrThrow({ where: { id: accepted.id } })).paymentStatus).toBe('PARTIALLY_PAID');
    const bank = await paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'BANK_TRANSFER', amount: 20_000, externalReference: `bank-${randomUUID()}` });
    expect((await db.payment.findUniqueOrThrow({ where: { id: bank.id } })).status).toBe('PENDING');
    expect(await paymentOps.history(f.ctx, accepted.id)).toMatchObject({ total: 35_000, paid: 15_000, pending: 20_000, outstanding: 20_000, availableToCollect: 0 });
    await paymentOps.verify(f.ctx, randomUUID(), bank.id);
    const final = await db.order.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(final).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    expect(await db.payment.count({ where: { orderId: accepted.id } })).toBe(2);
    expect(await db.kitchenTicket.count({ where: { orderId: accepted.id } })).toBe(1);
    expect(await db.orderItem.count({ where: { orderId: accepted.id } })).toBe(1);
    expect(await db.cashMovement.count({ where: { shiftId: (await db.cashShift.findFirstOrThrow({ where: { storeId: f.ctx.storeId } })).id } })).toBe(0);
    expect(cash.id).not.toBe(bank.id);
  });

  it('serializes competing partial payments and refuses an overpayment', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const orderItem = await db.orderItem.findFirstOrThrow({ where: { orderId: accepted.id } });
    const itemSplit = await paymentOps.split(f.ctx, randomUUID(), accepted.id, { label: 'Selected dish', itemIds: [orderItem.id] });
    expect(await db.billSplit.findUniqueOrThrow({ where: { id: itemSplit.id } })).toMatchObject({ amount: 35_000, itemIds: [orderItem.id] });
    const attempts = await Promise.allSettled([
      paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'BANK_TRANSFER', amount: 20_000, externalReference: `race-${randomUUID()}` }),
      paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'BANK_TRANSFER', amount: 20_000, externalReference: `race-${randomUUID()}` }),
    ]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await db.payment.aggregate({ where: { orderId: accepted.id }, _sum: { amount: true } })).toMatchObject({ _sum: { amount: 20_000 } });
    const winner = attempts.find(x => x.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('EXPECTED_ONE_PAYMENT');
    const current = await getOrder(accepted.id);
    await expect(ops.cash(f.ctx, randomUUID(), accepted.id, { tendered: 35_000, expectedVersion: current.version })).rejects.toThrow('PAYMENT_VERIFICATION_PENDING');
    await paymentOps.failPending(f.ctx, randomUUID(), winner.value.id, 'Bank transfer not found in statement');
    expect(await db.payment.findUniqueOrThrow({ where: { id: winner.value.id } })).toMatchObject({ status: 'FAILED' });
    const retry = await paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'BANK_TRANSFER', amount: 20_000, externalReference: `retry-${randomUUID()}` });
    expect(retry.id).not.toBe(winner.value.id);
  });

  it('deduplicates bank references and callback effects, and scopes payment history to the caller store', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const externalReference = `bank-${randomUUID()}`;
    const payment = await paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'BANK_TRANSFER', amount: 35_000, externalReference });
    await paymentOps.verify(f.ctx, randomUUID(), payment.id);
    await expect(paymentOps.verify(f.ctx, randomUUID(), payment.id)).rejects.toThrow('PAYMENT_NOT_VERIFIABLE');
    const other = await fixture();
    await expect(paymentOps.history(other.ctx, accepted.id)).rejects.toThrow('ORDER_NOT_FOUND');
    await expect(paymentOps.requestRefund(other.ctx, randomUUID(), payment.id, { amount: 1_000, reason: 'Wrong store attempt' })).rejects.toThrow('SETTLED_PAYMENT_NOT_FOUND');
    const otherOrder = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, otherOrder.id, 'START'); await advance(f.ctx, otherOrder.id, 'READY'); await advance(f.ctx, otherOrder.id, 'HANDOFF');
    await expect(paymentOps.record(f.ctx, randomUUID(), otherOrder.id, { method: 'BANK_TRANSFER', amount: 35_000, externalReference })).rejects.toThrow('DUPLICATE_PAYMENT_REFERENCE');
    await expect(paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'CARD', amount: 1_000 })).rejects.toThrow('CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED');
    expect(await db.payment.count({ where: { id: payment.id } })).toBe(1);
  });

  it('requests and approves partial refunds as compensating entries without changing original payment', async () => {
    const f = await fixture(); await openShift(f.ctx);
    const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    await paymentOps.record(f.ctx, randomUUID(), accepted.id, { method: 'CASH', amount: 35_000, tendered: 35_000 });
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: accepted.id } });
    const itemId = (await db.orderItem.findFirstOrThrow({ where: { orderId: accepted.id } })).id;
    const refund = await paymentOps.requestRefund(f.ctx, randomUUID(), payment.id, { amount: 5_000, reason: 'Customer reported quality issue', itemId });
    await paymentOps.decideRefund(f.ctx, randomUUID(), refund.id, { decision: 'APPROVED', reason: 'Manager approved verified issue' });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ amount: 35_000, status: 'SETTLED' });
    expect(await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'APPROVED', amount: 5_000 });
    expect(await db.cashMovement.findFirstOrThrow({ where: { paymentId: payment.id, kind: 'REFUND' } })).toMatchObject({ amount: 5_000 });
    expect((await db.order.findUniqueOrThrow({ where: { id: accepted.id } })).paymentStatus).toBe('PARTIALLY_REFUNDED');
    await expect(paymentOps.requestRefund(f.ctx, randomUUID(), payment.id, { amount: 31_000, reason: 'Exceeds remaining refundable amount' })).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');
    await expect(paymentOps.requestRefund(f.ctx, randomUUID(), payment.id, { amount: 31_000, reason: 'Exceeds item snapshot price', itemId })).rejects.toThrow('ITEM_REFUND_EXCEEDS_PRICE');
  });
  it('opens a shift, posts cash movements, reconciles a matching count and records financial audit', async () => {
    const f = await fixture(); const shift = await openShift(f.ctx, 10_000);
    await cashShifts.move(f.ctx, randomUUID(), { shiftId: shift.id, kind: 'CASH_IN', amount: 5_000, reason: 'Till float top up' });
    await cashShifts.move(f.ctx, randomUUID(), { shiftId: shift.id, kind: 'CASH_OUT', amount: 2_000, reason: 'Paid delivery fee' });
    const current = await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } });
    const closed = await cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: current.version, countedAmount: 13_000 });
    expect((await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe('CLOSED');
    expect((await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } })).expectedAmount).toBe(13_000);
    expect(await db.cashMovement.count({ where: { shiftId: shift.id } })).toBe(2);
    expect(await db.audit.count({ where: { tenantId: f.ctx.tenantId } })).toBe(4);
    expect(await db.outbox.count({ where: { tenantId: f.ctx.tenantId } })).toBe(4);
    await expect(cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: closed.version, countedAmount: 13_000 })).rejects.toThrow();
    await expect(db.cashMovement.updateMany({ where: { shiftId: shift.id }, data: { reason: 'Edited' } })).rejects.toThrow('immutable cash ledger');
  });
  it('requires a reason and manager approval for a cash discrepancy', async () => {
    const f = await fixture(); const shift = await openShift(f.ctx, 20_000);
    await expect(cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: shift.version, countedAmount: 19_000 })).rejects.toThrow('DISCREPANCY_REASON_REQUIRED');
    const closing = await cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: shift.version, countedAmount: 19_000, reason: 'One thousand short' });
    expect((await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe('CLOSING');
    const manager = { ...f.ctx, role: 'MANAGER' as const };
    await cashShifts.approve(manager, randomUUID(), shift.id, { expectedVersion: closing.version, reason: 'Count verified by manager' });
    const closed = await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(closed).toMatchObject({ status: 'CLOSED', approvalStatus: 'APPROVED', discrepancy: -1_000, approvedBy: f.ctx.userId });
  });
  it('records refunds as bounded compensating cash movements without changing the payment', async () => {
    const f = await fixture(); const shift = await openShift(f.ctx);
    const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const order = await getOrder(accepted.id);
    await ops.cash(f.ctx, randomUUID(), order.id, { tendered: 35_000, expectedVersion: order.version });
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    await cashShifts.move(f.ctx, randomUUID(), { shiftId: shift.id, kind: 'REFUND', paymentId: payment.id, amount: 10_000, reason: 'Partial quality refund' });
    await expect(cashShifts.move(f.ctx, randomUUID(), { shiftId: shift.id, kind: 'REFUND', paymentId: payment.id, amount: 26_000, reason: 'Excess refund attempt' })).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ amount: 35_000, tendered: 35_000, cashShiftId: shift.id });
    const current = await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } });
    await cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: current.version, countedAmount: 25_000 });
  });
  it('rejects cross-store shift access and serializes a payment against shift close', async () => {
    const f = await fixture(); const shift = await openShift(f.ctx);
    const other = await fixture();
    await expect(cashShifts.close(other.ctx, randomUUID(), shift.id, { expectedVersion: shift.version, countedAmount: 0 })).rejects.toThrow('SHIFT_NOT_FOUND');
    const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const o = await getOrder(accepted.id);
    const results = await Promise.allSettled([
      ops.cash(f.ctx, randomUUID(), o.id, { tendered: 35_000, expectedVersion: o.version }),
      cashShifts.close(f.ctx, randomUUID(), shift.id, { expectedVersion: shift.version, countedAmount: 35_000 }),
    ]);
    const payment = await db.payment.findFirst({ where: { orderId: o.id } });
    const savedShift = await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(payment ? payment.cashShiftId === shift.id : results[0]?.status === 'rejected').toBe(true);
    if (payment) expect(savedShift.status === 'OPEN' ? savedShift.expectedAmount === null : savedShift.expectedAmount === payment.amount).toBe(true);
    else expect(savedShift.expectedAmount).toBe(0);
  });
  it('creates catalog, receipts, prices variants and modifiers, and keeps accepted recipe snapshots immutable', async () => {
    const f = await fixture();
    const category = await catalog.createCategory(f.ctx, randomUUID(), 'Hot drinks');
    const stationId = (await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).stationId;
    const create = await catalog.createProduct(f.ctx, randomUUID(), { name: 'Configured drink', description: 'Recipe test', price: 35000, active: true, manualAvailable: true, stationId, categoryId: category.id, recipe: [{ ingredientId: f.ingredients[0]!.id, quantity: '10', unit: 'g' }] });
    await catalog.receipt(f.ctx, randomUUID(), { reference: `RCPT-${randomUUID().slice(0, 8)}`, supplier: 'Test supplier', lines: [{ ingredientId: f.ingredients[0]!.id, quantity: '5', unit: 'g' }] });
    const variant = await catalog.saveVariant(f.ctx, randomUUID(), create.id, undefined, undefined, { name: 'Large', active: true, price: 45000, recipeMultiplier: '1.5' });
    const group = await catalog.saveGroup(f.ctx, randomUUID(), create.id, undefined, undefined, { name: 'Topping', active: true, minSelections: 1, maxSelections: 1 });
    const modifier = await catalog.saveModifier(f.ctx, randomUUID(), group.id, undefined, undefined, { name: 'Extra milk', active: true, priceDelta: 5000, recipe: [{ ingredientId: f.ingredients[1]!.id, quantity: '2', unit: 'g' }] });
    const accepted = await ops.accept(f.ctx, randomUUID(), { lines: [{ productId: create.id, quantity: 1, variantId: variant.id, modifierIds: [modifier.id] }] });
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: accepted.id } });
    expect(item.unitPrice).toBe(50000);
    expect(item.recipeSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ ingredientId: f.ingredients[0]!.id, quantity: '15.000' }), expect.objectContaining({ ingredientId: f.ingredients[1]!.id, quantity: '2.000' })]));
    expect(item.selectionSnapshot).toMatchObject({ variantId: variant.id, modifiers: [{ id: modifier.id, priceDelta: 5000 }] });
    await catalog.saveVariant(f.ctx, randomUUID(), create.id, variant.id, variant.version, { name: 'Large', active: true, price: 99000, recipeMultiplier: '2' });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).unitPrice).toBe(50000);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).recipeSnapshot).toEqual(item.recipeSnapshot);
    const changed = await catalog.updateProduct(f.ctx, randomUUID(), create.id, create.version, { name: 'Configured drink', description: 'Updated recipe', price: 36000, active: true, manualAvailable: true, stationId, categoryId: category.id, recipe: [{ ingredientId: f.ingredients[0]!.id, quantity: '20', unit: 'g' }] });
    expect(changed.version).toBe(2);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: item.id } })).recipeSnapshot).toEqual(item.recipeSnapshot);
    expect(await db.recipeRevision.count({ where: { productId: create.id } })).toBe(2);
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, kind: 'RECEIPT' } })).toBe(1);
    await expect(catalog.updateProduct(f.ctx, randomUUID(), create.id, create.version, { name: 'Stale', description: '', price: 1, active: true, manualAvailable: true, stationId, categoryId: category.id, recipe: [{ ingredientId: f.ingredients[0]!.id, quantity: '1', unit: 'g' }] })).rejects.toThrow('STALE_VERSION');
  });
  it('accepts, consumes snapshots, hands off, takes cash, reports and reconciles ledger', async () => {
    const f = await fixture(); await openShift(f.ctx); const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    const initial = await getOrder(accepted.id);
    expect(initial.total).toBe(35000); expect(initial.items).toHaveLength(1);
    expect(await db.kitchenTicket.count({ where: { orderId: accepted.id } })).toBe(1);
    // Mutable catalog changes cannot change accepted price/recipe consumption.
    await db.product.update({ where: { id: f.product.id }, data: { price: 99000, recipeVersion: 2 } });
    await db.recipeItem.updateMany({ where: { productId: f.product.id }, data: { quantity: '50' } });
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    const o = await getOrder(accepted.id); const paymentKey = randomUUID();
    const paid = await ops.cash(f.ctx, paymentKey, o.id, { tendered: 50000, expectedVersion: o.version });
    expect(await ops.cash(f.ctx, paymentKey, o.id, { tendered: 50000, expectedVersion: o.version })).toEqual(paid);
    const completed = await getOrder(o.id); expect(completed.status).toBe('COMPLETED'); expect(completed.payments[0]?.amount).toBe(35000); expect(completed.payments[0]?.change).toBe(15000);
    const sums = await db.payment.aggregate({ where: { tenantId: f.ctx.tenantId }, _sum: { amount: true } }); expect(sums._sum.amount).toBe(35000);
    for (const i of f.ingredients) {
      const b = await db.balance.findUniqueOrThrow({ where: { tenantId_storeId_ingredientId: { tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, ingredientId: i.id } } });
      expect(b.onHand.toString()).toBe('90'); expect(b.reserved.toString()).toBe('0');
      const sums = await db.movement.aggregate({ where: { ingredientId: i.id }, _sum: { onHandDelta: true, reservedDelta: true } });
      expect(sums._sum.onHandDelta?.equals(b.onHand)).toBe(true); expect(sums._sum.reservedDelta?.equals(b.reserved)).toBe(true);
    }
    expect(await db.audit.count({ where: { tenantId: f.ctx.tenantId } })).toBe(6);
    expect(await db.outbox.count({ where: { tenantId: f.ctx.tenantId } })).toBe(6);
    await expect(ops.cash(f.ctx, randomUUID(), o.id, { tendered: 50000, expectedVersion: completed.version })).rejects.toThrow('ORDER_NOT_PAYABLE');
  });
  it('accepts exactly one concurrent request for the last portion of multiple ingredients', async () => {
    const f = await fixture('10');
    const results = await Promise.allSettled([ops.accept(f.ctx, randomUUID(), f.body), ops.accept(f.ctx, randomUUID(), f.body)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.order.count({ where: { storeId: f.ctx.storeId } })).toBe(1);
    expect(await db.reservation.count({ where: { storeId: f.ctx.storeId } })).toBe(2);
    const balances = await db.balance.findMany({ where: { storeId: f.ctx.storeId } });
    expect(balances.every(b => b.onHand.sub(b.reserved).eq(0))).toBe(true);
  });
  it('does not leave a partial reservation when a later ingredient is short', async () => {
    const f = await fixture(); const last = [...f.ingredients].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
    await ops.adjust(f.ctx, randomUUID(), { ingredientId: last.id, delta: '-95', reason: 'Test shortage' });
    await expect(ops.accept(f.ctx, randomUUID(), f.body)).rejects.toThrow('INSUFFICIENT_STOCK');
    expect(await db.order.count({ where: { storeId: f.ctx.storeId } })).toBe(0);
    expect(await db.reservation.count({ where: { storeId: f.ctx.storeId } })).toBe(0);
    expect((await db.balance.findMany({ where: { storeId: f.ctx.storeId } })).every(b => b.reserved.isZero())).toBe(true);
  });
  it('deduplicates concurrent identical commands and rejects key reuse with a changed payload', async () => {
    const f = await fixture(); const key = randomUUID();
    const [a, b] = await Promise.all([ops.accept(f.ctx, key, f.body), ops.accept(f.ctx, key, f.body)]); expect(a).toEqual(b);
    expect(await db.order.count({ where: { storeId: f.ctx.storeId } })).toBe(1);
    await expect(ops.accept(f.ctx, key, { lines: [{ productId: f.product.id, quantity: 2 }] })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });
  it('releases only unprepared units and classifies consumed cancellation as waste without restocking', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), { lines: [{ productId: f.product.id, quantity: 2 }] });
    let o = await getOrder(accepted.id); const [a, b] = o.items; if (!a || !b) throw new Error('fixture');
    await ops.item(f.ctx, randomUUID(), a.id, { action: 'CANCEL', expectedVersion: o.version });
    o = await getOrder(o.id); expect(o.total).toBe(35000); expect(o.status).toBe('ACCEPTED');
    await ops.item(f.ctx, randomUUID(), b.id, { action: 'START', expectedVersion: o.version });
    o = await getOrder(o.id); await ops.item(f.ctx, randomUUID(), b.id, { action: 'CANCEL', expectedVersion: o.version });
    o = await getOrder(o.id); expect(o.status).toBe('CANCELLED'); expect(o.total).toBe(0);
    const balances = await db.balance.findMany({ where: { storeId: f.ctx.storeId } }); expect(balances.every(b => b.onHand.eq(90) && b.reserved.eq(0))).toBe(true);
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, kind: 'WASTE' } })).toBe(2);
  });
  it('rejects stale transitions and duplicate start under different keys without double consumption', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), f.body); const o = await getOrder(accepted.id); const item = o.items[0]!;
    await advance(f.ctx, o.id, 'START');
    await expect(ops.item(f.ctx, randomUUID(), item.id, { action: 'READY', expectedVersion: o.version })).rejects.toThrow('STALE_OR_TERMINAL_ORDER');
    await expect(ops.item(f.ctx, randomUUID(), item.id, { action: 'START', expectedVersion: o.version + 1 })).rejects.toThrow('INVALID_TRANSITION');
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, kind: 'CONSUME' } })).toBe(2);
  });
  it('replays ordered kitchen commands idempotently and records a conflicting version without a second effect', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), f.body); let order = await getOrder(accepted.id); const item = order.items[0]!; const commandId = randomUUID();
    const started = await ops.item(f.ctx, commandId, item.id, { action: 'START', expectedVersion: order.version });
    expect(await ops.item(f.ctx, commandId, item.id, { action: 'START', expectedVersion: order.version })).toEqual(started);
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, itemId: item.id, kind: 'CONSUME' } })).toBe(2);
    order = await getOrder(accepted.id);
    const readied = await ops.item(f.ctx, randomUUID(), item.id, { action: 'READY', expectedVersion: order.version });
    expect(readied.version).toBe(order.version + 1);
    await expect(ops.item(f.ctx, randomUUID(), item.id, { action: 'START', expectedVersion: order.version })).rejects.toThrow('STALE_OR_TERMINAL_ORDER');
    expect((await getOrder(accepted.id)).items[0]?.status).toBe('READY');
    expect(await db.movement.count({ where: { storeId: f.ctx.storeId, itemId: item.id, kind: 'CONSUME' } })).toBe(2);
  });
  it('binds kitchen device identities to the user and store and honors revocation', async () => {
    const f = await fixture(); const deviceId = randomUUID();
    const station = await db.station.findFirstOrThrow({ where: { tenantId: f.ctx.tenantId, storeId: f.ctx.storeId } });
    const row = await db.kitchenDevice.create({ data: { id: deviceId, tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, userId: f.ctx.userId, stationId: station.id } });
    expect(await db.kitchenDevice.findFirst({ where: { id: deviceId, tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, userId: f.ctx.userId, revokedAt: null } })).toEqual(row);
    expect(await db.kitchenDevice.findFirst({ where: { id: deviceId, tenantId: f.ctx.tenantId, storeId: f.ctx.storeId }, include: { station: true } })).toMatchObject({ station: { id: station.id, name: station.name } });
    expect(await db.kitchenDevice.findFirst({ where: { id: deviceId, storeId: randomUUID(), userId: f.ctx.userId, revokedAt: null } })).toBeNull();
    await db.kitchenDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    expect(await db.kitchenDevice.findFirst({ where: { id: deviceId, tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, userId: f.ctx.userId, revokedAt: null } })).toBeNull();
  });
  it('creates single-use store invitations with hashed tokens and assigns the invited employee', async () => {
    const f = await fixture(); const email = `invited-${randomUUID()}@test.invalid`;
    const invitation = await pilotAdmin.createInvitation(f.ctx, { email, role: 'KITCHEN' });
    expect(invitation.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.storeInvitation.findUnique({ where: { id: invitation.id } })).toMatchObject({ tokenHash: digest(invitation.token), email, role: 'KITCHEN', storeId: f.ctx.storeId });
    expect((await pilotAdmin.listInvitations(f.ctx)).find(row => row.id === invitation.id)).toMatchObject({ status: 'PENDING' });
    expect(await pilotAdmin.acceptInvitation(invitation.token, 'long-enough-pilot-password')).toMatchObject({ accepted: true, email, storeId: f.ctx.storeId });
    const employee = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.membership.findUnique({ where: { userId_storeId: { userId: employee.id, storeId: f.ctx.storeId } } })).toMatchObject({ tenantId: f.ctx.tenantId, role: 'KITCHEN' });
    await expect(pilotAdmin.acceptInvitation(invitation.token, 'long-enough-pilot-password')).rejects.toThrow('INVITATION_INVALID_OR_EXPIRED');
  });
  it('rejects cross-tenant objects and composite foreign-key corruption', async () => {
    const a = await fixture(); const b = await fixture(); const o = await ops.accept(a.ctx, randomUUID(), a.body); const item = (await getOrder(o.id)).items[0]!;
    await expect(ops.item(b.ctx, randomUUID(), item.id, { action: 'START', expectedVersion: o.version })).rejects.toThrow('ITEM_NOT_FOUND');
    await expect(ops.accept(b.ctx, randomUUID(), a.body)).rejects.toThrow('PRODUCT_UNAVAILABLE_OR_NO_RECIPE');
    await expect(db.recipeItem.create({ data: { tenantId: b.ctx.tenantId, storeId: b.ctx.storeId, productId: b.product.id, ingredientId: a.ingredients[0]!.id, quantity: '1' } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
  it('revalidates revoked sessions and current role inside commands', async () => {
    const f = await fixture();
    await db.membership.update({ where: { userId_storeId: { userId: f.ctx.userId, storeId: f.ctx.storeId } }, data: { role: 'KITCHEN' } });
    await expect(ops.accept(f.ctx, randomUUID(), f.body)).rejects.toThrow('PERMISSION_DENIED');
    await db.session.delete({ where: { tokenHash: f.ctx.tokenHash } });
    await expect(authenticate(db, f.token)).rejects.toThrow('SESSION_EXPIRED');
    await expect(ops.accept(f.ctx, randomUUID(), f.body)).rejects.toThrow('SESSION_REVOKED');
  });
  it('enforces balance check and append-only ledger at database level', async () => {
    const f = await fixture('10'); await ops.accept(f.ctx, randomUUID(), f.body);
    await expect(ops.adjust(f.ctx, randomUUID(), { ingredientId: f.ingredients[0]!.id, delta: '-1', reason: 'Below reservation' })).rejects.toThrow('STOCK_BELOW_RESERVED_OR_NOT_FOUND');
    await expect(db.balance.updateMany({ where: { storeId: f.ctx.storeId }, data: { reserved: 1000 } })).rejects.toThrow();
    await expect(db.movement.updateMany({ where: { storeId: f.ctx.storeId }, data: { onHandDelta: 0 } })).rejects.toThrow();
  });
  it('handles overlapping distinct recipes and reversed input ordering atomically', async () => {
    const f = await fixture('30');
    const other = await db.product.create({ data: { tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, stationId: f.product.stationId, name: 'Other recipe', price: 20000 } });
    for (const ingredient of [...f.ingredients].reverse()) await db.recipeItem.create({ data: { tenantId: f.ctx.tenantId, storeId: f.ctx.storeId, productId: other.id, ingredientId: ingredient.id, quantity: '20' } });
    const lines = [{ productId: f.product.id, quantity: 1 }, { productId: other.id, quantity: 1 }];
    const results = await Promise.allSettled([ops.accept(f.ctx, randomUUID(), { lines }), ops.accept(f.ctx, randomUUID(), { lines: [...lines].reverse() })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.reservation.count({ where: { storeId: f.ctx.storeId } })).toBe(4);
    expect((await db.balance.findMany({ where: { storeId: f.ctx.storeId } })).every(b => b.reserved.eq(30))).toBe(true);
  });
  it('rejects insufficient cash without committing a payment and blocks paid cancellation', async () => {
    const f = await fixture(); await openShift(f.ctx); const accepted = await ops.accept(f.ctx, randomUUID(), f.body);
    await advance(f.ctx, accepted.id, 'START'); await advance(f.ctx, accepted.id, 'READY'); await advance(f.ctx, accepted.id, 'HANDOFF');
    let o = await getOrder(accepted.id); const key = randomUUID();
    await expect(ops.cash(f.ctx, key, o.id, { tendered: 1, expectedVersion: o.version })).rejects.toThrow('INSUFFICIENT_CASH');
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
    expect(await db.commandReceipt.count({ where: { storeId: f.ctx.storeId, key } })).toBe(0);
    await ops.cash(f.ctx, key, o.id, { tendered: 35000, expectedVersion: o.version });
    o = await getOrder(o.id);
    await expect(ops.item(f.ctx, randomUUID(), o.items[0]!.id, { action: 'CANCEL', expectedVersion: o.version })).rejects.toThrow('STALE_OR_TERMINAL_ORDER');
  });
  it('allows only one concurrent kitchen mutation at an aggregate version', async () => {
    const f = await fixture(); const accepted = await ops.accept(f.ctx, randomUUID(), { lines: [{ productId: f.product.id, quantity: 2 }] });
    const o = await getOrder(accepted.id);
    const results = await Promise.allSettled(o.items.map(item => ops.item(f.ctx, randomUUID(), item.id, { action: 'START', expectedVersion: o.version })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getOrder(o.id)).items.filter(i => i.status === 'PREPARING')).toHaveLength(1);
    expect((await db.balance.findMany({ where: { storeId: f.ctx.storeId } })).every(b => b.onHand.eq(90) && b.reserved.eq(10))).toBe(true);
  });
});
