import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from '../../apps/api/node_modules/ioredis';
import { Operations } from '../../apps/api/src/operations';
import { CatalogOperations } from '../../apps/api/src/catalog-operations';
import { CashShifts } from '../../apps/api/src/cash-shifts';
import { Payments } from '../../apps/api/src/payments';
import { PilotAdmin } from '../../apps/api/src/pilot-admin';
import { cashExpected, digest, hashPasswordAsync } from '../../apps/api/src/domain';
import {
  createOutboxWorkerLoop,
  listDeadLetterOutbox,
  OUTBOX_CHANNEL,
  processOutboxBatch,
  replayDeadLetterOutbox,
} from '../../apps/api/src/outbox';
import { setRateLimitRedisHealthProbe } from '../../apps/api/src/rate-limit';
import { createEventDeduplicator, setRealtimeRedisHealthProbe } from '../../apps/api/src/realtime';
import type { Context } from '../../apps/api/src/auth';

const TEST_ORIGIN = 'http://localhost:3000';
const db = new PrismaClient();
const ops = new Operations(db);
const catalog = new CatalogOperations(db);
const cashShifts = new CashShifts(db);
const paymentOps = new Payments(db);
const pilotAdmin = new PilotAdmin(db);

type ConfiguredHttpApp = {
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): http.Server;
  close(): Promise<void>;
};

let app: ConfiguredHttpApp;
let baseUrl = '';

async function httpJson(
  method: string,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    Origin: TEST_ORIGIN,
    ...(opts.cookie ? { Cookie: `session=${opts.cookie}` } : {}),
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers ?? {}),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, headers: response.headers, json, text };
}

type RoleName = 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN' | 'INVENTORY';

async function createStoreFixture() {
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const password = `Hardening-${randomUUID()}-Aa1!`;
  const passwordHash = await hashPasswordAsync(password);

  const roles: RoleName[] = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'];
  const users: Record<RoleName, { id: string; email: string; token: string; ctx: Context }> = {} as never;

  const data = await db.$transaction(async tx => {
    await tx.tenant.create({ data: { id: tenantId, name: `Tenant ${tenantId.slice(0, 6)}` } });
    await tx.store.create({ data: { id: storeId, tenantId, name: `Store ${storeId.slice(0, 6)}` } });

    for (const role of roles) {
      const userId = randomUUID();
      const email = `${role.toLowerCase()}-${userId.slice(0, 8)}@test.invalid`;
      const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const tokenHash = digest(token);
      const expiresAt = new Date(Date.now() + 3600_000);
      await tx.user.create({ data: { id: userId, email, passwordHash } });
      await tx.membership.create({ data: { userId, tenantId, storeId, role } });
      await tx.session.create({ data: { tenantId, storeId, userId, tokenHash, expiresAt } });
      users[role] = {
        id: userId,
        email,
        token,
        ctx: { tenantId, storeId, userId, role, tokenHash, expiresAt, correlationId: randomUUID() },
      };
    }

    const station = await tx.station.create({ data: { tenantId, storeId, name: 'Main Station' } });
    const ingredient = await tx.ingredient.create({ data: { tenantId, storeId, name: 'Coffee Beans', unit: 'g' } });
    await tx.balance.create({ data: { tenantId, storeId, ingredientId: ingredient.id, onHand: '1000' } });
    const product = await tx.product.create({
      data: { tenantId, storeId, stationId: station.id, name: 'Espresso', price: 35_000 },
    });
    await tx.recipeItem.create({
      data: { tenantId, storeId, productId: product.id, ingredientId: ingredient.id, quantity: '10' },
    });
    const register = await tx.cashRegister.findFirstOrThrow({ where: { tenantId, storeId } });
    return { station, ingredient, product, register };
  });

  return { tenantId, storeId, password, users, ...data };
}

async function addStoreMember(
  store: { tenantId: string; storeId: string; password: string },
  role: RoleName,
): Promise<{ id: string; email: string; token: string; ctx: Context }> {
  const userId = randomUUID();
  const email = `${role.toLowerCase()}-extra-${userId.slice(0, 8)}@test.invalid`;
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const tokenHash = digest(token);
  const expiresAt = new Date(Date.now() + 3600_000);
  const passwordHash = await hashPasswordAsync(store.password);
  await db.$transaction(async tx => {
    await tx.user.create({ data: { id: userId, email, passwordHash } });
    await tx.membership.create({
      data: { userId, tenantId: store.tenantId, storeId: store.storeId, role },
    });
    await tx.session.create({
      data: { tenantId: store.tenantId, storeId: store.storeId, userId, tokenHash, expiresAt },
    });
  });
  return {
    id: userId,
    email,
    token,
    ctx: {
      tenantId: store.tenantId,
      storeId: store.storeId,
      userId,
      role,
      tokenHash,
      expiresAt,
      correlationId: randomUUID(),
    },
  };
}

async function createHandedOffOrder(ctx: Context, productId: string, quantity = 1) {
  const accepted = await ops.accept(ctx, randomUUID(), { lines: [{ productId, quantity }] });
  let order = await db.order.findUniqueOrThrow({ where: { id: accepted.id }, include: { items: true } });
  for (const item of order.items) {
    for (const action of ['START', 'READY', 'HANDOFF'] as const) {
      order = await db.order.findUniqueOrThrow({ where: { id: accepted.id }, include: { items: true } });
      await ops.item(ctx, randomUUID(), item.id, { action, expectedVersion: order.version });
    }
  }
  return db.order.findUniqueOrThrow({ where: { id: accepted.id }, include: { items: true } });
}

beforeAll(async () => {
  setRateLimitRedisHealthProbe(async () => 'PONG');
  setRealtimeRedisHealthProbe(() => true);
  const httpAppModuleId = ['..', '..', 'apps', 'api', 'src', 'http-app'].join('/');
  const { createConfiguredHttpApp } = (await import(httpAppModuleId)) as {
    createConfiguredHttpApp: (options?: {
      origin?: string;
      enableAccessLogs?: boolean;
      enableMetrics?: boolean;
    }) => Promise<ConfiguredHttpApp>;
  };
  app = await createConfiguredHttpApp({ origin: TEST_ORIGIN, enableAccessLogs: false, enableMetrics: false });
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  setRateLimitRedisHealthProbe(async () => 'PONG');
  setRealtimeRedisHealthProbe(undefined);
  await app?.close();
  await db.$disconnect();
});

describe('P0/P1 Financial integrity, RBAC/IDOR, DB constraints, readiness, and Outbox DLQ', () => {
  it('supports refunds on partially paid orders, blocks unpaid/over/concurrent refunds, and preserves idempotency', async () => {
    const store = await createStoreFixture();
    const cashier = store.users.CASHIER;
    const manager = store.users.MANAGER;
    const shift = await cashShifts.open(cashier.ctx, randomUUID(), {
      registerId: store.register.id,
      openingAmount: 50_000,
    });
    const order = await createHandedOffOrder(store.users.OWNER.ctx, store.product.id);

    // Partial payment of 15,000 on 35,000 order -> ACCEPTED / PARTIALLY_PAID
    const partialPay = await paymentOps.record(cashier.ctx, randomUUID(), order.id, {
      method: 'CASH',
      amount: 15_000,
      tendered: 15_000,
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'ACCEPTED',
      paymentStatus: 'PARTIALLY_PAID',
    });

    // Refund > captured amount (unpaid amount) is rejected
    await expect(
      paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
        amount: 20_000,
        reason: 'Attempt to refund unpaid balance',
      }),
    ).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');

    // Manager approves partial refund of 5,000 using cashier's explicit OPEN shiftId (NO 500 CHECK violation!)
    const refundKey = randomUUID();
    const refund1 = await paymentOps.requestRefund(cashier.ctx, refundKey, partialPay.id, {
      amount: 5_000,
      reason: 'Partial refund on partial payment',
    });
    // Duplicate idempotency key with identical payload replays cleanly; modified payload throws 409
    expect(
      await paymentOps.requestRefund(cashier.ctx, refundKey, partialPay.id, {
        amount: 5_000,
        reason: 'Partial refund on partial payment',
      }),
    ).toEqual(refund1);
    await expect(
      paymentOps.requestRefund(cashier.ctx, refundKey, partialPay.id, {
        amount: 6_000,
        reason: 'Different amount same key',
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');

    // Manager has NO own shift: omitting shiftId must fail (never silently pick cashier's shift!)
    await expect(
      paymentOps.decideRefund(manager.ctx, randomUUID(), refund1.id, {
        decision: 'APPROVED',
        reason: 'Missing explicit shift selection',
      }),
    ).rejects.toThrow('OPEN_CASH_SHIFT_REQUIRED_FOR_CASH_REFUND');

    // Approving with explicit cashier shiftId succeeds and separates approving manager from shift cashier
    await paymentOps.decideRefund(manager.ctx, randomUUID(), refund1.id, {
      decision: 'APPROVED',
      reason: 'Approved against cashier open shift',
      shiftId: shift.id,
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'ACCEPTED',
      paymentStatus: 'PARTIALLY_REFUNDED',
    });
    const movement = await db.cashMovement.findFirstOrThrow({ where: { refundId: refund1.id } });
    expect(movement).toMatchObject({
      shiftId: shift.id,
      actorId: manager.id,
      kind: 'REFUND',
      amount: 5_000,
    });
    const shiftRow = await db.cashShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(shiftRow.cashierId).toBe(cashier.id);
    expect(movement.actorId).not.toBe(shiftRow.cashierId);

    // Two simultaneous refund requests for 8,000 each against 10,000 remaining -> exactly one succeeds
    const concurrent = await Promise.allSettled([
      paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
        amount: 8_000,
        reason: 'Concurrent refund A',
      }),
      paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
        amount: 8_000,
        reason: 'Concurrent refund B',
      }),
    ]);
    expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(r => r.status === 'rejected')).toHaveLength(1);

    // Refund exceeding remaining refundable amount (2,000 left) is rejected
    await expect(
      paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
        amount: 3_000,
        reason: 'Exceeds remaining refundable',
      }),
    ).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');

    // Approve the winning 8,000 refund and then refund final 2,000 -> ACCEPTED / REFUNDED
    const winner = concurrent.find((r): r is PromiseFulfilledResult<{ id: string; version: number }> => r.status === 'fulfilled')!;
    await paymentOps.decideRefund(manager.ctx, randomUUID(), winner.value.id, {
      decision: 'APPROVED',
      reason: 'Approve second partial refund',
      shiftId: shift.id,
    });
    const finalRefund = await paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
      amount: 2_000,
      reason: 'Refund final captured balance',
    });
    await paymentOps.decideRefund(manager.ctx, randomUUID(), finalRefund.id, {
      decision: 'APPROVED',
      reason: 'Approve final captured refund',
      shiftId: shift.id,
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'ACCEPTED',
      paymentStatus: 'REFUNDED',
    });
    expect(await db.payment.findUniqueOrThrow({ where: { id: partialPay.id } })).toMatchObject({
      status: 'SETTLED',
      amount: 15_000,
    });
    const shiftMovementsAfterFullRefund = await db.cashMovement.findMany({
      where: { shiftId: shift.id, kind: 'REFUND' },
      orderBy: { createdAt: 'asc' },
    });
    expect(shiftMovementsAfterFullRefund.map(m => m.amount)).toEqual([5_000, 8_000, 2_000]);
    expect(cashExpected(50_000, 15_000, shiftMovementsAfterFullRefund)).toBe(50_000);
    // Attempting any additional refund once total refunded reaches captured amount (15,000) is rejected
    await expect(
      paymentOps.requestRefund(cashier.ctx, randomUUID(), partialPay.id, {
        amount: 1_000,
        reason: 'Over-refund after full captured ceiling',
      }),
    ).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');
  }, 20_000);

  it('enforces shift ownership, closed-shift, cross-store, balance, invalid payment state, and cash movement refund authorization', async () => {
    const storeA = await createStoreFixture();
    const storeB = await createStoreFixture();

    const shiftA = await cashShifts.open(storeA.users.CASHIER.ctx, randomUUID(), {
      registerId: storeA.register.id,
      openingAmount: 0,
    });
    const shiftB = await cashShifts.open(storeB.users.CASHIER.ctx, randomUUID(), {
      registerId: storeB.register.id,
      openingAmount: 100_000,
    });

    const order = await createHandedOffOrder(storeA.users.OWNER.ctx, storeA.product.id);

    // Invalid payment state: PENDING bank transfer cannot be refunded
    const pendingBank = await paymentOps.record(storeA.users.CASHIER.ctx, randomUUID(), order.id, {
      method: 'BANK_TRANSFER',
      amount: 10_000,
      externalReference: `pending-${randomUUID()}`,
    });
    await expect(
      paymentOps.requestRefund(storeA.users.CASHIER.ctx, randomUUID(), pendingBank.id, {
        amount: 5_000,
        reason: 'Pending payment refund attempt',
      }),
    ).rejects.toThrow('SETTLED_PAYMENT_NOT_FOUND');

    // Settle cash payment of 25,000 on shiftA
    const cashPay = await paymentOps.record(storeA.users.CASHIER.ctx, randomUUID(), order.id, {
      method: 'CASH',
      amount: 25_000,
      tendered: 25_000,
    });

    // BE-03: CASHIER cannot bypass refund approval via POST /cash/movements kind=REFUND
    const bypassRes = await httpJson('POST', '/cash/movements', {
      cookie: storeA.users.CASHIER.token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        shiftId: shiftA.id,
        kind: 'REFUND',
        amount: 5_000,
        reason: 'Cashier direct refund bypass',
        paymentId: cashPay.id,
      },
    });
    expect(bypassRes.status).toBe(403);
    expect(bypassRes.json).toMatchObject({ code: 'REFUND_APPROVAL_REQUIRED' });

    // Take 20,000 out of drawer so remaining expected drawer cash is 5,000
    await cashShifts.move(storeA.users.CASHIER.ctx, randomUUID(), {
      shiftId: shiftA.id,
      kind: 'CASH_OUT',
      amount: 20_000,
      reason: 'Cash drop to safe',
    });

    // Request refund of 10,000 (valid vs 25,000 payment, but exceeds 5,000 cash in shiftA!)
    const refund = await paymentOps.requestRefund(storeA.users.CASHIER.ctx, randomUUID(), cashPay.id, {
      amount: 10_000,
      reason: 'Drawer balance check refund',
    });

    // Unauthorized manager (CASHIER) rejected
    const cashierApprove = await httpJson('POST', `/refunds/${refund.id}/decision`, {
      cookie: storeA.users.CASHIER.token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { decision: 'APPROVED', reason: 'Self approval attempt', shiftId: shiftA.id },
    });
    expect(cashierApprove.status).toBe(403);

    // Cross-tenant manager rejected
    await expect(
      paymentOps.decideRefund(storeB.users.MANAGER.ctx, randomUUID(), refund.id, {
        decision: 'APPROVED',
        reason: 'Cross tenant refund decision',
        shiftId: shiftB.id,
      }),
    ).rejects.toThrow('REFUND_NOT_FOUND');

    // Cross-store shiftId rejected
    await expect(
      paymentOps.decideRefund(storeA.users.MANAGER.ctx, randomUUID(), refund.id, {
        decision: 'APPROVED',
        reason: 'Other store shift attempt',
        shiftId: shiftB.id,
      }),
    ).rejects.toThrow('SHIFT_NOT_FOUND');

    // Drawer balance would go negative -> rejected with CASH_BALANCE_OUT_OF_RANGE
    await expect(
      paymentOps.decideRefund(storeA.users.MANAGER.ctx, randomUUID(), refund.id, {
        decision: 'APPROVED',
        reason: 'Would make drawer negative',
        shiftId: shiftA.id,
      }),
    ).rejects.toThrow('CASH_BALANCE_OUT_OF_RANGE');

    // Close shiftA -> approving against closed shift rejected with SHIFT_NOT_OPEN
    const shiftBeforeClose = await db.cashShift.findUniqueOrThrow({ where: { id: shiftA.id } });
    await cashShifts.close(storeA.users.CASHIER.ctx, randomUUID(), shiftA.id, {
      expectedVersion: shiftBeforeClose.version,
      countedAmount: 5_000,
    });
    await expect(
      paymentOps.decideRefund(storeA.users.MANAGER.ctx, randomUUID(), refund.id, {
        decision: 'APPROVED',
        reason: 'Closed shift refund attempt',
        shiftId: shiftA.id,
      }),
    ).rejects.toThrow('SHIFT_NOT_OPEN');
    // Verify PostgreSQL state remained completely untouched after SHIFT_NOT_OPEN rejection
    expect(await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({
      status: 'REQUESTED',
      approvedBy: null,
      approvedAt: null,
    });
    expect(await db.refundDecision.count({ where: { refundId: refund.id } })).toBe(0);
    expect(await db.cashMovement.count({ where: { refundId: refund.id } })).toBe(0);
    expect(await db.cashShift.findUniqueOrThrow({ where: { id: shiftA.id } })).toMatchObject({
      status: 'CLOSED',
      countedAmount: 5_000,
      version: shiftBeforeClose.version + 1,
    });
  }, 20_000);

  it('enforces BillSplit integrity, CashShift DB constraints/triggers, and required PostgreSQL indexes', async () => {
    const store = await createStoreFixture();
    const order = await createHandedOffOrder(store.users.OWNER.ctx, store.product.id);
    await paymentOps.split(store.users.OWNER.ctx, randomUUID(), order.id, { label: 'Guest 1', amount: 15_000 });

    // Cannot cancel item or order once BillSplit exists
    const current = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    await expect(
      ops.item(store.users.OWNER.ctx, randomUUID(), current.items[0]!.id, {
        action: 'CANCEL',
        expectedVersion: current.version,
      }),
    ).rejects.toThrow('ORDER_HAS_BILL_SPLITS');
    await expect(
      ops.cancelOrder(store.users.OWNER.ctx, randomUUID(), order.id, {
        expectedVersion: current.version,
        reason: 'Cancel with split attempt',
      }),
    ).rejects.toThrow('ORDER_HAS_BILL_SPLITS');

    // DB-02: CashShift DELETE trigger & discrepancy CHECK constraint
    const shift = await cashShifts.open(store.users.OWNER.ctx, randomUUID(), {
      registerId: store.register.id,
      openingAmount: 10_000,
    });
    await expect(
      db.$executeRaw`DELETE FROM "CashShift" WHERE id = ${shift.id}::uuid`,
    ).rejects.toThrow(/cash shift deletion is forbidden/i);

    await expect(
      db.$executeRaw`
        UPDATE "CashShift"
        SET status = 'CLOSING', "expectedAmount" = 10000, "countedAmount" = 9000, discrepancy = -1000,
            "closingAt" = now(), "approvalStatus" = 'NOT_REQUIRED'
        WHERE id = ${shift.id}::uuid
      `,
    ).rejects.toThrow();

    // DB-01: Verify Payment.orderId index and Outbox partial indexes exist in PostgreSQL
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'Payment_tenantId_storeId_orderId_createdAt_idx',
        'Outbox_pending_ready_idx',
        'Outbox_dead_letter_idx',
        'Refund_tenantId_storeId_paymentId_status_idx'
      )
    `;
    const names = new Set(indexes.map(row => row.indexname));
    expect(names.has('Payment_tenantId_storeId_orderId_createdAt_idx')).toBe(true);
    expect(names.has('Outbox_pending_ready_idx')).toBe(true);
    expect(names.has('Outbox_dead_letter_idx')).toBe(true);
    expect(names.has('Refund_tenantId_storeId_paymentId_status_idx')).toBe(true);
  });

  it('enforces RBAC & IDOR protections across orders, payments, invitations, kitchen devices, catalog, and readiness', async () => {
    const storeA = await createStoreFixture();
    const storeB = await createStoreFixture();
    const order = await createHandedOffOrder(storeA.users.OWNER.ctx, storeA.product.id);
    const shift = await cashShifts.open(storeA.users.CASHIER.ctx, randomUUID(), {
      registerId: storeA.register.id,
      openingAmount: 0,
    });
    await paymentOps.record(storeA.users.CASHIER.ctx, randomUUID(), order.id, {
      method: 'CASH',
      amount: 35_000,
      tendered: 35_000,
    });

    // SEC-01: INVENTORY denied on GET /orders and GET /orders/:id/payments
    expect((await httpJson('GET', '/orders', { cookie: storeA.users.INVENTORY.token })).status).toBe(403);
    expect((await httpJson('GET', `/orders/${order.id}/payments`, { cookie: storeA.users.INVENTORY.token })).status).toBe(403);

    // SEC-01: KITCHEN denied on GET /orders/:id/payments and receives zero financial data on GET /orders
    const kitchenDeviceId = randomUUID();
    const reg = await httpJson('POST', '/kitchen/devices/register', {
      cookie: storeA.users.KITCHEN.token,
      body: { deviceId: kitchenDeviceId },
    });
    expect(reg.status).toBe(201);
    const kitchenOrders = await httpJson('GET', '/orders', {
      cookie: storeA.users.KITCHEN.token,
      headers: { 'X-Kitchen-Device': kitchenDeviceId },
    });
    expect(kitchenOrders.status).toBe(200);
    const kitchenOrderList = kitchenOrders.json as { id: string; payments: unknown[]; refunds: unknown[]; billSplits: unknown[] }[];
    const seenOrder = kitchenOrderList.find(o => o.id === order.id);
    expect(seenOrder).toBeDefined();
    expect(seenOrder?.payments).toEqual([]);
    expect(seenOrder?.refunds).toEqual([]);
    expect(seenOrder?.billSplits).toEqual([]);
    expect((await httpJson('GET', `/orders/${order.id}/payments`, { cookie: storeA.users.KITCHEN.token })).status).toBe(403);

    // Cross-store IDOR on GET /orders/:id/payments
    expect((await httpJson('GET', `/orders/${order.id}/payments`, { cookie: storeB.users.OWNER.token })).status).toBe(404);
    expect((await httpJson('GET', `/orders/${order.id}/payments`, { cookie: storeA.users.CASHIER.token })).status).toBe(200);

    // SEC-02: MANAGER cannot revoke a MANAGER invitation; deactivated user cannot accept invitation
    const managerInvite = await pilotAdmin.createInvitation(storeA.users.OWNER.ctx, {
      email: `mgr-${randomUUID().slice(0, 8)}@test.invalid`,
      role: 'MANAGER',
    });
    const managerRevokeRes = await httpJson('POST', `/admin/invitations/${managerInvite.id}/revoke`, {
      cookie: storeA.users.MANAGER.token,
    });
    expect(managerRevokeRes.status).toBe(403);
    expect(managerRevokeRes.json).toMatchObject({ code: 'INVITATION_ROLE_NOT_ALLOWED' });

    // Cross-store revoke attempt returns 404
    const crossRevokeRes = await httpJson('POST', `/admin/invitations/${managerInvite.id}/revoke`, {
      cookie: storeB.users.OWNER.token,
    });
    expect(crossRevokeRes.status).toBe(404);

    // Deactivated existing user accepting invite returns unified 401 INVITATION_INVALID_OR_EXPIRED
    const inactiveEmail = `inactive-${randomUUID().slice(0, 8)}@test.invalid`;
    const inactivePass = 'Inactive-Valid-Pass-123!';
    await db.user.create({
      data: { email: inactiveEmail, passwordHash: await hashPasswordAsync(inactivePass), active: false },
    });
    const inactiveInvite = await pilotAdmin.createInvitation(storeA.users.OWNER.ctx, {
      email: inactiveEmail,
      role: 'CASHIER',
    });
    const acceptInactive = await httpJson('POST', `/public/invitations/${inactiveInvite.token}/accept`, {
      body: { password: inactivePass },
    });
    expect(acceptInactive.status).toBe(401);
    expect(acceptInactive.json).toMatchObject({ code: 'INVITATION_INVALID_OR_EXPIRED' });

    // SEC-02: Role-change race in ops.item() requires kitchenDeviceId for KITCHEN role
    const freshOrder = await ops.accept(storeA.users.OWNER.ctx, randomUUID(), {
      lines: [{ productId: storeA.product.id, quantity: 1 }],
    });
    const freshOrderRow = await db.order.findUniqueOrThrow({ where: { id: freshOrder.id }, include: { items: true } });
    await expect(
      ops.item(storeA.users.KITCHEN.ctx, randomUUID(), freshOrderRow.items[0]!.id, {
        action: 'START',
        expectedVersion: freshOrderRow.version,
      }),
    ).rejects.toThrow('KITCHEN_DEVICE_REQUIRED');

    // BE-05: updateProduct rejects recipe incompatible with active variant multiplier without breaking GET /catalog
    await catalog.saveVariant(storeA.users.OWNER.ctx, randomUUID(), storeA.product.id, undefined, undefined, {
      name: 'Half',
      active: true,
      price: 20_000,
      recipeMultiplier: '0.500',
    });
    const prodBefore = await db.product.findUniqueOrThrow({ where: { id: storeA.product.id } });
    await expect(
      catalog.updateProduct(storeA.users.OWNER.ctx, randomUUID(), storeA.product.id, prodBefore.version, {
        name: prodBefore.name,
        description: '',
        price: 35_000,
        active: true,
        manualAvailable: true,
        stationId: storeA.station.id,
        categoryId: null,
        recipe: [{ ingredientId: storeA.ingredient.id, quantity: '0.001', unit: 'g' }],
      }),
    ).rejects.toThrow('RECIPE_PRECISION_OR_RANGE');
    const catalogRes = await httpJson('GET', '/catalog', { cookie: storeA.users.OWNER.token });
    expect(catalogRes.status).toBe(200);

    // BE-07: GET /ready returns 503 (never 500) when Redis probe throws, then recovers to 200
    setRateLimitRedisHealthProbe(async () => {
      throw new Error('Redis disconnected');
    });
    const degradedReady = await httpJson('GET', '/ready');
    expect(degradedReady.status).toBe(503);
    expect(degradedReady.json).toMatchObject({ code: 'REDIS_REQUIRED_FOR_PROTECTED_RATE_LIMITS' });

    setRateLimitRedisHealthProbe(async () => 'PONG');
    const recoveredReady = await httpJson('GET', '/ready');
    expect(recoveredReady.status).toBe(200);

    // Malformed input & invalid session
    expect((await httpJson('GET', '/orders', { cookie: '0'.repeat(64) })).status).toBe(401);
    const badInput = await httpJson('POST', `/orders/${order.id}/payments`, {
      cookie: storeA.users.CASHIER.token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { method: 'CASH', amount: -500, tendered: 1000 },
    });
    expect(badInput.status).toBe(400);
    expect(shift.id).toBeTruthy();
  }, 20_000);

  it('persists Outbox retries, transitions exhausted rows to DLQ, and replays them via admin API', async () => {
    const storeA = await createStoreFixture();
    const storeB = await createStoreFixture();

    const row = await db.outbox.create({
      data: {
        tenantId: storeA.tenantId,
        storeId: storeA.storeId,
        type: 'order.accepted',
        aggregateId: randomUUID(),
        version: 1,
        correlationId: randomUUID(),
        maxAttempts: 2,
      },
    });

    const failingRedis = { publish: async () => { throw new Error('REDIS_DOWN'); } };

    // Attempt 1: scheduled for retry with backoff (attempts = 1, deadLetteredAt = null)
    const first = await processOutboxBatch({
      db,
      redis: failingRedis,
      tenantIds: [storeA.tenantId],
      retryBaseBackoffMs: 50,
      retryMaxBackoffMs: 100,
    });
    expect(first.retried).toBe(1);
    const afterFirst = await db.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.deadLetteredAt).toBeNull();
    expect(afterFirst.lastError).toContain('REDIS_DOWN');

    // Make row immediately due and fail attempt 2 -> durable DLQ
    await db.outbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    const second = await processOutboxBatch({
      db,
      redis: failingRedis,
      tenantIds: [storeA.tenantId],
    });
    expect(second.deadLettered).toBe(1);
    const afterSecond = await db.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.deadLetteredAt).not.toBeNull();

    // Admin visibility is tenant-isolated
    const dlqA = await httpJson('GET', '/admin/outbox/dead-letters', { cookie: storeA.users.OWNER.token });
    expect(dlqA.status).toBe(200);
    expect((dlqA.json as { id: string }[]).some(item => item.id === row.id)).toBe(true);
    const dlqB = await httpJson('GET', '/admin/outbox/dead-letters', { cookie: storeB.users.OWNER.token });
    expect(dlqB.status).toBe(200);
    expect((dlqB.json as { id: string }[]).some(item => item.id === row.id)).toBe(false);
    expect((await httpJson('GET', '/admin/outbox/dead-letters', { cookie: storeA.users.CASHIER.token })).status).toBe(403);

    // Safe replay via admin API restores row to pending and delivers once Redis recovers
    const replayRes = await httpJson('POST', '/admin/outbox/dead-letters/replay', {
      cookie: storeA.users.OWNER.token,
      body: { ids: [row.id] },
    });
    expect(replayRes.status).toBe(201);
    expect(replayRes.json).toEqual({ replayed: 1, ids: [row.id] });
    expect(await listDeadLetterOutbox(db, { tenantId: storeA.tenantId, storeId: storeA.storeId })).toHaveLength(0);

    const published: string[] = [];
    const recovered = await processOutboxBatch({
      db,
      redis: { publish: async (_ch, payload) => { published.push(payload); return 1; } },
      tenantIds: [storeA.tenantId],
    });
    expect(recovered.delivered).toBe(1);
    expect(published).toHaveLength(1);
    expect((await db.outbox.findUniqueOrThrow({ where: { id: row.id } })).deliveredAt).not.toBeNull();

    // Replaying an already-delivered row is a no-op (prevents duplicate replay side effects)
    expect(await replayDeadLetterOutbox(db, { tenantId: storeA.tenantId, storeId: storeA.storeId, ids: [row.id] })).toEqual({
      replayed: 0,
      ids: [],
    });
  });

  it('prevents double approval and duplicate cash movements when two independent managers approve the same refund concurrently', async () => {
    const store = await createStoreFixture();
    const managerA = store.users.MANAGER;
    const managerB = await addStoreMember(store, 'MANAGER');
    const cashier = store.users.CASHIER;

    const shift = await cashShifts.open(cashier.ctx, randomUUID(), {
      registerId: store.register.id,
      openingAmount: 50_000,
    });
    const order = await createHandedOffOrder(store.users.OWNER.ctx, store.product.id);
    const payment = await paymentOps.record(cashier.ctx, randomUUID(), order.id, {
      method: 'CASH',
      amount: 35_000,
      tendered: 35_000,
    });
    const pendingRefund = await paymentOps.requestRefund(cashier.ctx, randomUUID(), payment.id, {
      amount: 10_000,
      reason: 'Concurrent manager approval test',
    });

    const results = await Promise.allSettled([
      paymentOps.decideRefund(managerA.ctx, randomUUID(), pendingRefund.id, {
        decision: 'APPROVED',
        reason: 'Manager A concurrent approval',
        shiftId: shift.id,
      }),
      paymentOps.decideRefund(managerB.ctx, randomUUID(), pendingRefund.id, {
        decision: 'APPROVED',
        reason: 'Manager B concurrent approval',
        shiftId: shift.id,
      }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ id: string; version: number }> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0]!.reason as Error).message)).toMatch(/REFUND_ALREADY_DECIDED|CONCURRENT_CHANGE_RETRY_SAME_KEY/);

    const winnerId = results[0]!.status === 'fulfilled' ? managerA.id : managerB.id;
    const refundRow = await db.refund.findUniqueOrThrow({ where: { id: pendingRefund.id } });
    expect(refundRow).toMatchObject({
      status: 'APPROVED',
      approvedBy: winnerId,
    });
    expect(refundRow.approvedAt).not.toBeNull();

    const decisions = await db.refundDecision.findMany({ where: { refundId: pendingRefund.id } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actorId: winnerId, decision: 'APPROVED' });

    const refundMovements = await db.cashMovement.findMany({ where: { refundId: pendingRefund.id } });
    expect(refundMovements).toHaveLength(1);
    expect(refundMovements[0]).toMatchObject({
      shiftId: shift.id,
      actorId: winnerId,
      kind: 'REFUND',
      amount: 10_000,
    });

    // Drawer balance deducted exactly once: 50,000 opening + 35,000 cash sale - 10,000 refund = 75,000
    const allShiftMovements = await db.cashMovement.findMany({ where: { shiftId: shift.id } });
    expect(cashExpected(50_000, 35_000, allShiftMovements)).toBe(75_000);

    const decisionAudits = await db.audit.findMany({
      where: { tenantId: store.tenantId, storeId: store.storeId, entityId: pendingRefund.id, action: 'refund.decided' },
    });
    expect(decisionAudits).toHaveLength(1);
    expect(decisionAudits[0]!.actorId).toBe(winnerId);

    const decisionOutbox = await db.outbox.findMany({
      where: { tenantId: store.tenantId, storeId: store.storeId, aggregateId: pendingRefund.id, type: 'refund.decided' },
    });
    expect(decisionOutbox).toHaveLength(1);
  }, 20_000);

  it('prevents over-refund when two independent staff accounts concurrently request refunds on the same payment', async () => {
    const store = await createStoreFixture();
    const cashierA = store.users.CASHIER;
    const cashierB = await addStoreMember(store, 'CASHIER');

    await cashShifts.open(cashierA.ctx, randomUUID(), {
      registerId: store.register.id,
      openingAmount: 20_000,
    });
    const order = await createHandedOffOrder(store.users.OWNER.ctx, store.product.id);
    const payment = await paymentOps.record(cashierA.ctx, randomUUID(), order.id, {
      method: 'CASH',
      amount: 10_000,
      tendered: 10_000,
    });

    // Two distinct cashiers with distinct idempotency keys concurrently request 7,000 each against 10,000 payment
    const concurrent = await Promise.allSettled([
      paymentOps.requestRefund(cashierA.ctx, randomUUID(), payment.id, {
        amount: 7_000,
        reason: 'Cashier A concurrent refund request',
      }),
      paymentOps.requestRefund(cashierB.ctx, randomUUID(), payment.id, {
        amount: 7_000,
        reason: 'Cashier B concurrent refund request',
      }),
    ]);

    expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrent.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0]!.reason as Error).message)).toMatch(/REFUND_EXCEEDS_PAYMENT|CONCURRENT_CHANGE_RETRY_SAME_KEY/);

    const winnerCashierId = concurrent[0]!.status === 'fulfilled' ? cashierA.id : cashierB.id;
    const loserCashier = concurrent[0]!.status === 'fulfilled' ? cashierB : cashierA;

    const refundsInDb = await db.refund.findMany({ where: { paymentId: payment.id } });
    expect(refundsInDb).toHaveLength(1);
    expect(refundsInDb[0]).toMatchObject({
      amount: 7_000,
      status: 'REQUESTED',
      requestedBy: winnerCashierId,
    });

    // Remaining refundable balance is strictly 3,000: 3,001 must fail, 3,000 must succeed
    await expect(
      paymentOps.requestRefund(loserCashier.ctx, randomUUID(), payment.id, {
        amount: 3_001,
        reason: 'Exceeds remaining 3,000',
      }),
    ).rejects.toThrow('REFUND_EXCEEDS_PAYMENT');

    await paymentOps.requestRefund(loserCashier.ctx, randomUUID(), payment.id, {
      amount: 3_000,
      reason: 'Exact remaining 3,000',
    });

    const finalRefunds = await db.refund.findMany({
      where: { paymentId: payment.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(finalRefunds).toHaveLength(2);
    expect(finalRefunds.reduce((sum, r) => sum + r.amount, 0)).toBe(10_000);
  }, 20_000);

  it('resumes pending and retryable Outbox events across a real worker stop/restart without duplicate business side effects', async () => {
    const store = await createStoreFixture();
    const baseMs = Date.now() - 5_000;
    const ev1 = await db.outbox.create({
      data: {
        tenantId: store.tenantId,
        storeId: store.storeId,
        type: 'order.accepted',
        aggregateId: randomUUID(),
        version: 1,
        correlationId: randomUUID(),
        createdAt: new Date(baseMs),
        nextAttemptAt: new Date(baseMs),
        maxAttempts: 3,
      },
    });
    const ev2 = await db.outbox.create({
      data: {
        tenantId: store.tenantId,
        storeId: store.storeId,
        type: 'order.accepted',
        aggregateId: randomUUID(),
        version: 1,
        correlationId: randomUUID(),
        createdAt: new Date(baseMs + 100),
        nextAttemptAt: new Date(baseMs + 100),
        maxAttempts: 3,
      },
    });
    const ev3 = await db.outbox.create({
      data: {
        tenantId: store.tenantId,
        storeId: store.storeId,
        type: 'order.accepted',
        aggregateId: randomUUID(),
        version: 1,
        correlationId: randomUUID(),
        createdAt: new Date(baseMs + 200),
        nextAttemptAt: new Date(baseMs + 200),
        maxAttempts: 3,
      },
    });

    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const pubClient = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null });
    const subClient = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null });
    pubClient.on('error', () => undefined);
    subClient.on('error', () => undefined);

    const deduper = createEventDeduplicator();
    const rawReceived: string[] = [];
    const appliedCountByEvent = new Map<string, number>();
    const payloadsByEvent = new Map<string, string>();
    const targetIds = new Set([ev1.id, ev2.id, ev3.id]);

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      expect(await pubClient.ping()).toBe('PONG');
      await subClient.subscribe(OUTBOX_CHANNEL);

      subClient.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message) as { eventId?: string; tenantId?: string };
          if (parsed.tenantId !== store.tenantId || !parsed.eventId || !targetIds.has(parsed.eventId)) return;
          rawReceived.push(parsed.eventId);
          payloadsByEvent.set(parsed.eventId, message);
          if (deduper.has(parsed.eventId)) return;
          deduper.mark(parsed.eventId);
          appliedCountByEvent.set(parsed.eventId, (appliedCountByEvent.get(parsed.eventId) ?? 0) + 1);
        } catch {
          // Ignore unrelated channel messages
        }
      });

      // Worker 1: delivers ev1 via real Redis, hits a transient Redis fault on ev2 (scheduling retry in DB),
      // and stops cleanly before processing ev3.
      let ev2FailedOnce = false;
      let worker1StopTriggered: Promise<void> | null = null;
      const worker1 = createOutboxWorkerLoop({
        db,
        redis: {
          publish: async (channel, payload) => {
            const parsed = JSON.parse(payload) as { eventId?: string };
            if (parsed.eventId === ev2.id && !ev2FailedOnce) {
              ev2FailedOnce = true;
              worker1StopTriggered = worker1.stop(5_000);
              throw new Error('REDIS_TRANSIENT_BEFORE_RESTART');
            }
            return pubClient.publish(channel, payload);
          },
        },
        batchSize: 10,
        pollIntervalMs: 30,
        baseBackoffMs: 50,
        maxBackoffMs: 100,
      });

      const run1 = worker1.run();
      const stopDeadline = Date.now() + 10_000;
      while (!ev2FailedOnce && Date.now() < stopDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ev2FailedOnce).toBe(true);
      await worker1StopTriggered;
      await run1;

      // Verify PostgreSQL persisted exact mid-restart state while worker is offline
      const ev1Mid = await db.outbox.findUniqueOrThrow({ where: { id: ev1.id } });
      const ev2Mid = await db.outbox.findUniqueOrThrow({ where: { id: ev2.id } });
      const ev3Mid = await db.outbox.findUniqueOrThrow({ where: { id: ev3.id } });
      expect(ev1Mid.deliveredAt).not.toBeNull();
      expect(ev2Mid.deliveredAt).toBeNull();
      expect(ev2Mid.deadLetteredAt).toBeNull();
      expect(ev2Mid.attempts).toBe(1);
      expect(ev2Mid.lastError).toContain('REDIS_TRANSIENT_BEFORE_RESTART');
      expect(ev3Mid.deliveredAt).toBeNull();
      expect(ev3Mid.deadLetteredAt).toBeNull();
      expect(ev3Mid.attempts).toBe(0);

      // Worker 2 (fresh instance simulating process restart): resumes pending ev3 and retryable ev2 once due
      const worker2 = createOutboxWorkerLoop({
        db,
        redis: { publish: (channel, payload) => pubClient.publish(channel, payload) },
        batchSize: 10,
        pollIntervalMs: 30,
        baseBackoffMs: 50,
        maxBackoffMs: 100,
      });
      const run2 = worker2.run();
      const recoverDeadline = Date.now() + 10_000;
      while (Date.now() < recoverDeadline) {
        const remaining = await db.outbox.count({
          where: { id: { in: [ev1.id, ev2.id, ev3.id] }, deliveredAt: null },
        });
        if (remaining === 0 && appliedCountByEvent.size === 3) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await worker2.stop(5_000);
      await run2;

      // Verify final PostgreSQL state: all 3 delivered, ev1 untouched since before restart
      const [ev1End, ev2End, ev3End] = await Promise.all([
        db.outbox.findUniqueOrThrow({ where: { id: ev1.id } }),
        db.outbox.findUniqueOrThrow({ where: { id: ev2.id } }),
        db.outbox.findUniqueOrThrow({ where: { id: ev3.id } }),
      ]);
      expect(ev1End.deliveredAt?.getTime()).toBe(ev1Mid.deliveredAt?.getTime());
      expect(ev2End.deliveredAt).not.toBeNull();
      expect(ev2End.attempts).toBe(1);
      expect(ev3End.deliveredAt).not.toBeNull();
      expect(ev3End.attempts).toBe(0);

      // Consumer observed all 3 events over real Redis pub/sub and applied each exactly once
      expect(appliedCountByEvent.get(ev1.id)).toBe(1);
      expect(appliedCountByEvent.get(ev2.id)).toBe(1);
      expect(appliedCountByEvent.get(ev3.id)).toBe(1);

      // Under at-least-once delivery (e.g., crash after publish before DB commit), consumer deduplication suppresses duplicates
      const ev1Payload = payloadsByEvent.get(ev1.id)!;
      expect(ev1Payload).toBeTruthy();
      await pubClient.publish(OUTBOX_CHANNEL, ev1Payload);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(rawReceived.filter(id => id === ev1.id).length).toBeGreaterThanOrEqual(2);
      expect(appliedCountByEvent.get(ev1.id)).toBe(1);

      // Replaying already-delivered Outbox rows is a no-op and produces zero additional deliveries
      expect(
        await replayDeadLetterOutbox(db, {
          tenantId: store.tenantId,
          storeId: store.storeId,
          ids: [ev1.id, ev2.id, ev3.id],
        }),
      ).toEqual({ replayed: 0, ids: [] });
    } finally {
      await subClient.quit().catch(() => subClient.disconnect());
      await pubClient.quit().catch(() => pubClient.disconnect());
    }
  }, 20_000);
});
