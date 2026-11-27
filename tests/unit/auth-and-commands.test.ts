import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticate, login, reauthorize, type Context } from '../../apps/api/src/auth';
import { LabeledCardSandboxAdapter, type CardProviderAdapter } from '../../apps/api/src/card-provider';
import { CommandBus, requirePermission } from '../../apps/api/src/commands';
import { digest, hashPassword } from '../../apps/api/src/domain';
import { Payments } from '../../apps/api/src/payments';

async function expectHttpError(work: Promise<unknown>, status: number, message?: string) {
  try {
    await work;
    expect.unreachable(`Expected HTTP ${status} error`);
  } catch (err) {
    const httpErr = err as Error & { getStatus?: () => number };
    expect(httpErr.getStatus?.()).toBe(status);
    if (message) expect(httpErr.message).toContain(message);
  }
}

class TestBus extends CommandBus {
  async run(ctx: Context, key: string, work: () => Promise<{ id: string; version: number }>) {
    return this.command(ctx, key, 'order.accepted', { sample: true }, async () => work(), 'pos');
  }
  async runPublic(ctx: Context, key: string, work: () => Promise<{ id: string; version: number }>) {
    return this.publicCommand(ctx, key, 'order.accepted', { sample: true }, async () => work());
  }
}

describe('auth and command bus guardrails', () => {
  it('rejects malformed or expired sessions and enforces active tenant membership', async () => {
    const token = 'a'.repeat(64);
    const tokenHash = digest(token);
    await expectHttpError(authenticate({} as PrismaClient, undefined), 401, 'SESSION_REQUIRED');
    await expectHttpError(authenticate({} as PrismaClient, 'not-hex-64'), 401, 'SESSION_REQUIRED');

    const expiredDb = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', tokenHash, expiresAt: new Date(Date.now() - 1000), user: { active: true } }) },
    } as unknown as PrismaClient;
    await expectHttpError(authenticate(expiredDb, token), 401, 'SESSION_EXPIRED');

    const crossTenantDb = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', tokenHash, expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't2', role: 'OWNER' }) },
    } as unknown as PrismaClient;
    await expectHttpError(authenticate(crossTenantDb, token), 403);

    const validDb = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', tokenHash, expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'MANAGER' }) },
    } as unknown as PrismaClient;
    expect(await authenticate(validDb, token, 'corr-1')).toMatchObject({ userId: 'u1', tenantId: 't1', storeId: 's1', role: 'MANAGER', correlationId: 'corr-1' });
  });

  it('revalidates role inside transactions and stores hashed session tokens on login', async () => {
    const ctx: Context = { tenantId: 't1', storeId: 's1', userId: 'u1', role: 'CASHIER', tokenHash: 'h', expiresAt: new Date(), correlationId: 'c1' };
    const revokedTx = {
      session: { findUnique: async () => null },
      membership: { findUnique: async () => null },
    };
    await expectHttpError(reauthorize(revokedTx as never, ctx), 401, 'SESSION_REVOKED');

    const updatedTx = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'MANAGER' }) },
    };
    expect((await reauthorize(updatedTx as never, ctx)).role).toBe('MANAGER');

    let storedSessionHash = '';
    const passwordHash = hashPassword('CorrectHorseBattery1!');
    const loginDb = {
      user: { findUnique: async ({ where: { email } }: { where: { email: string } }) => email === 'owner@test.invalid' ? { id: 'u1', active: true, passwordHash } : null },
      membership: { findUnique: async ({ where: { userId_storeId: { storeId } } }: { where: { userId_storeId: { storeId: string } } }) => storeId === 's1' ? { tenantId: 't1', role: 'OWNER' } : null },
      session: { create: async ({ data: { tokenHash } }: { data: { tokenHash: string } }) => { storedSessionHash = tokenHash; } },
    } as unknown as PrismaClient;
    await expectHttpError(login(loginDb, 'missing@test.invalid', 'WrongPass123!', 's1'), 401, 'INVALID_CREDENTIALS');
    await expectHttpError(login(loginDb, 'owner@test.invalid', 'CorrectHorseBattery1!', 'other-store'), 401, 'INVALID_CREDENTIALS');
    const created = await login(loginDb, 'OWNER@test.invalid', 'CorrectHorseBattery1!', 's1');
    expect(created.token).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSessionHash).toBe(digest(created.token));
    expect(storedSessionHash).not.toBe(created.token);
  });

  it('enforces UUIDv4 idempotency keys, payload mismatch detection, and bounded serialization retries', async () => {
    const ctx: Context = { tenantId: 't1', storeId: 's1', userId: 'u1', role: 'OWNER', tokenHash: 'h', expiresAt: new Date(), correlationId: 'c1' };
    try {
      requirePermission({ ...ctx, role: 'KITCHEN' }, 'cash');
      expect.unreachable('Expected HTTP 403');
    } catch (err) {
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(403);
    }

    const bus = new TestBus({} as PrismaClient);
    await expectHttpError(bus.run(ctx, 'not-a-uuid-v4', async () => ({ id: '1', version: 1 })), 400);
    await expectHttpError(bus.runPublic(ctx, '00000000-0000-1000-8000-000000000000', async () => ({ id: '1', version: 1 })), 400, 'IDEMPOTENCY_KEY_UUID_V4_REQUIRED');

    const storedReceipt: { hash: string; response: { id: string; version: number } } | null = {
      hash: digest(JSON.stringify({ actor: ctx.userId, operation: 'order.accepted', payload: { sample: true } })),
      response: { id: 'order-1', version: 1 },
    };
    const txBase = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'OWNER' }) },
      commandReceipt: { findUnique: async () => storedReceipt as typeof storedReceipt | null, create: async () => undefined },
      audit: { create: async () => undefined },
      outbox: { create: async () => undefined },
    };

    const replayBus = new TestBus({ $transaction: async (fn: (tx: typeof txBase) => Promise<unknown>) => fn(txBase) } as unknown as PrismaClient);
    expect(await replayBus.run(ctx, randomUUID(), async () => ({ id: 'should-not-run', version: 99 }))).toEqual({ id: 'order-1', version: 1 });
    await expectHttpError(replayBus.runPublic({ ...ctx, userId: 'other-actor' }, randomUUID(), async () => ({ id: 'x', version: 1 })), 409, 'IDEMPOTENCY_KEY_REUSED');

    let attempts = 0;
    const retryError = new Prisma.PrismaClientKnownRequestError('serialization failure', { code: 'P2034', clientVersion: '6.19.0' });
    const retryBus = new TestBus({
      $transaction: async (fn: (tx: typeof txBase) => Promise<unknown>) => {
        attempts++;
        return fn({ ...txBase, commandReceipt: { ...txBase.commandReceipt, findUnique: async () => null } });
      },
    } as unknown as PrismaClient);
    await expectHttpError(retryBus.run(ctx, randomUUID(), async () => { throw retryError; }), 409);
    expect(attempts).toBe(4);
  });

  it('enforces cash permission and fresh session reauthorization before invoking card payment provider', async () => {
    const baseCtx: Context = { tenantId: 't1', storeId: 's1', userId: 'u1', role: 'CASHIER', tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000), correlationId: 'c1' };
    const orderId = '00000000-0000-4000-8000-000000000001';
    const sandbox = new LabeledCardSandboxAdapter();

    let providerCalls = 0;
    const spyProvider: CardProviderAdapter = {
      name: sandbox.name,
      enabledForProduction: sandbox.enabledForProduction,
      async chargeCard(amountVnd: number): Promise<never> {
        providerCalls++;
        return sandbox.chargeCard(amountVnd);
      },
    };

    // 1. Unauthorized roles (KITCHEN / INVENTORY) are rejected before DB reauthorization or card provider call.
    let dbLookups = 0;
    const unusedDb = {
      session: { findUnique: async () => { dbLookups++; return null; } },
      membership: { findUnique: async () => { dbLookups++; return null; } },
    } as unknown as PrismaClient;
    const kitchenPayments = new Payments(unusedDb, spyProvider);
    await expectHttpError(kitchenPayments.record({ ...baseCtx, role: 'KITCHEN' }, randomUUID(), orderId, { amount: 50_000, method: 'CARD' }), 403, 'PERMISSION_DENIED');
    await expectHttpError(kitchenPayments.record({ ...baseCtx, role: 'INVENTORY' }, randomUUID(), orderId, { amount: 50_000, method: 'CARD' }), 403, 'PERMISSION_DENIED');
    expect(providerCalls).toBe(0);
    expect(dbLookups).toBe(0);

    // 2. Revoked session is rejected before card provider is called.
    const revokedDb = {
      session: { findUnique: async () => null },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'CASHIER' }) },
    } as unknown as PrismaClient;
    const revokedPayments = new Payments(revokedDb, spyProvider);
    await expectHttpError(revokedPayments.record(baseCtx, randomUUID(), orderId, { amount: 50_000, method: 'CARD' }), 401, 'SESSION_REVOKED');
    expect(providerCalls).toBe(0);

    // 3. Role downgraded in DB from CASHIER to KITCHEN is rejected before card provider is called.
    const downgradedDb = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'KITCHEN' }) },
    } as unknown as PrismaClient;
    const downgradedPayments = new Payments(downgradedDb, spyProvider);
    await expectHttpError(downgradedPayments.record(baseCtx, randomUUID(), orderId, { amount: 50_000, method: 'CARD' }), 403, 'PERMISSION_DENIED');
    expect(providerCalls).toBe(0);

    // 4. Active authorized CASHIER reaches card provider (outside any write transaction) and receives sandbox rejection.
    let transactionOpened = false;
    const activeDb = {
      session: { findUnique: async () => ({ userId: 'u1', tenantId: 't1', storeId: 's1', expiresAt: new Date(Date.now() + 60_000), user: { active: true } }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'CASHIER' }) },
      $transaction: async () => { transactionOpened = true; throw new Error('UNEXPECTED_TRANSACTION'); },
    } as unknown as PrismaClient;
    const activePayments = new Payments(activeDb, spyProvider);
    await expectHttpError(activePayments.record(baseCtx, randomUUID(), orderId, { amount: 50_000, method: 'CARD' }), 400, 'CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED');
    expect(providerCalls).toBe(1);
    expect(transactionOpened).toBe(false);
  });
});
