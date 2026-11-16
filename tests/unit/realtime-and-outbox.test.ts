import { EventEmitter } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as createSocketClient, type Socket as ClientSocket } from '../../apps/web/node_modules/socket.io-client';
import { digest } from '../../apps/api/src/domain';
import { createMetricsRegistry } from '../../apps/api/src/observability/metrics';
import {
  computeBackoffMs,
  createOutboxWorkerLoop,
  processOutboxBatch,
  resolveOutboxTiming,
} from '../../apps/api/src/outbox';
import {
  attachRealtime,
  broadcastOperationalEvent,
  createEventDeduplicator,
  extractCookieValue,
  publishRealtimeOperationalEvent,
  realtimeRedisReady,
  revalidateRealtimeSockets,
  setRealtimeRedisHealthProbe,
  type RealtimeRedisLike,
  type RealtimeServerLike,
  type RealtimeSocketLike,
} from '../../apps/api/src/realtime';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const STORE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_STORE_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const STATION_A = '55555555-5555-4555-8555-555555555555';
const STATION_B = '66666666-6666-4666-8666-666666666666';
const DEVICE_A = '77777777-7777-4777-8777-777777777777';
const DEVICE_B = '88888888-8888-4888-8888-888888888888';

function mockSocket(data: Record<string, unknown>, id = 'sock') {
  return {
    id,
    data,
    emit: vi.fn<RealtimeSocketLike['emit']>(),
    disconnect: vi.fn<RealtimeSocketLike['disconnect']>(),
  };
}

describe('Realtime cookie decoding, room isolation, and batched lookups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes valid URI-encoded cookies and safely ignores malformed encodings', () => {
    const encodedToken = 'token%2Dvalue%3D1';
    expect(extractCookieValue(`theme=dark; session=${encodedToken}; other=2`, 'session')).toBe('token-value=1');
    expect(extractCookieValue('session=%E0%A4%A', 'session')).toBeUndefined();
    expect(extractCookieValue('other=1', 'session')).toBeUndefined();
    expect(extractCookieValue(undefined, 'session')).toBeUndefined();
  });

  it('isolates rooms, disconnects mismatched/revoked sockets, and avoids N+1 queries across many clients', async () => {
    const cashierToken = digest('cashier-token');
    const managerToken = digest('manager-token');
    const kitchenToken = digest('kitchen-token');
    const otherStoreToken = digest('other-store-token');

    const cashierSockets = Array.from({ length: 6 }, (_, i) =>
      mockSocket({ token: cashierToken, room: `${TENANT_ID}:${STORE_ID}` }, `cashier-${i}`),
    );
    const kitchenSocketA = mockSocket(
      { token: kitchenToken, room: `${TENANT_ID}:${STORE_ID}`, deviceId: DEVICE_A, stationId: STATION_A },
      'kitchen-a',
    );
    const kitchenSocketB = mockSocket(
      { token: kitchenToken, room: `${TENANT_ID}:${STORE_ID}`, deviceId: DEVICE_B, stationId: STATION_B },
      'kitchen-b',
    );
    const tamperedRoomSocket = mockSocket(
      { token: otherStoreToken, room: `${TENANT_ID}:${OTHER_STORE_ID}` },
      'tampered-room',
    );
    const misplacedCustomerSocket = mockSocket(
      { customerTrackingHash: digest('tracking'), room: `${TENANT_ID}:${STORE_ID}` },
      'misplaced-customer',
    );
    const managerMissingRoom = mockSocket({ token: managerToken }, 'no-room');

    const allInRoom = [
      ...cashierSockets,
      kitchenSocketA,
      kitchenSocketB,
      tamperedRoomSocket,
      misplacedCustomerSocket,
      managerMissingRoom,
    ];

    const customerEmit = vi.fn();
    const io: RealtimeServerLike = {
      to: vi.fn(() => ({ emit: customerEmit })),
      in: vi.fn(() => ({ fetchSockets: vi.fn(async () => allInRoom) })),
    };

    const sessionFindMany = vi.fn(async () => [
      { tokenHash: digest(cashierToken), userId: 'u-cashier', tenantId: TENANT_ID, storeId: STORE_ID },
      { tokenHash: digest(kitchenToken), userId: 'u-kitchen', tenantId: TENANT_ID, storeId: STORE_ID },
    ]);
    const membershipFindMany = vi.fn(async () => [
      { userId: 'u-cashier', tenantId: TENANT_ID, storeId: STORE_ID, role: 'CASHIER' },
      { userId: 'u-kitchen', tenantId: TENANT_ID, storeId: STORE_ID, role: 'KITCHEN' },
    ]);
    const kitchenDeviceFindMany = vi.fn(async () => [
      { id: DEVICE_A, tenantId: TENANT_ID, storeId: STORE_ID, userId: 'u-kitchen', stationId: STATION_A },
      { id: DEVICE_B, tenantId: TENANT_ID, storeId: STORE_ID, userId: 'u-kitchen', stationId: STATION_B },
    ]);
    const kitchenTicketFindMany = vi.fn(async () => [{ stationId: STATION_A }]);

    const fakeDb = {
      session: { findMany: sessionFindMany },
      membership: { findMany: membershipFindMany },
      kitchenDevice: { findMany: kitchenDeviceFindMany },
      kitchenTicket: { findMany: kitchenTicketFindMany },
    } as unknown as PrismaClient;

    const event = {
      eventId: '99999999-9999-4999-8999-999999999999',
      schemaVersion: 1 as const,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      type: 'order.accepted' as const,
      aggregateId: ORDER_ID,
      version: 1,
      occurredAt: new Date().toISOString(),
    };

    await broadcastOperationalEvent(io, fakeDb, event);

    expect(io.to).toHaveBeenCalledWith(`${TENANT_ID}:${STORE_ID}:order:${ORDER_ID}`);
    expect(customerEmit).toHaveBeenCalledWith('customer.order.updated');

    for (const sock of cashierSockets) {
      expect(sock.emit).toHaveBeenCalledWith('operational.event', event);
      expect(sock.disconnect).not.toHaveBeenCalled();
    }
    expect(kitchenSocketA.emit).toHaveBeenCalledWith('operational.event', event);
    expect(kitchenSocketA.disconnect).not.toHaveBeenCalled();
    expect(kitchenSocketB.emit).not.toHaveBeenCalled();
    expect(kitchenSocketB.disconnect).not.toHaveBeenCalled();

    expect(tamperedRoomSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(misplacedCustomerSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(managerMissingRoom.disconnect).toHaveBeenCalledTimes(1);

    // Total batched queries stay O(1) = 4 queries instead of scaling per connected socket.
    expect(sessionFindMany).toHaveBeenCalledTimes(1);
    expect(membershipFindMany).toHaveBeenCalledTimes(1);
    expect(kitchenDeviceFindMany).toHaveBeenCalledTimes(1);
    expect(kitchenTicketFindMany).toHaveBeenCalledTimes(1);
  });

  it('disconnects drifted rooms, revoked kitchen devices, and stale tracking tokens during periodic revalidation', async () => {
    const validUserToken = digest('valid-user');
    const driftedRoomToken = digest('drifted-room');
    const revokedKitchenToken = digest('revoked-kitchen');
    const validTracking = digest('valid-tracking');
    const staleTracking = digest('stale-tracking');

    const validEmployee = mockSocket({ token: validUserToken, room: `${TENANT_ID}:${STORE_ID}` }, 'emp-ok');
    const driftedEmployee = mockSocket({ token: driftedRoomToken, room: `${TENANT_ID}:${OTHER_STORE_ID}` }, 'emp-drift');
    const reassignedKitchen = mockSocket(
      { token: revokedKitchenToken, room: `${TENANT_ID}:${STORE_ID}`, deviceId: DEVICE_A, stationId: STATION_A },
      'kitchen-stale-station',
    );
    const validCustomer = mockSocket({ customerTrackingHash: validTracking }, 'cust-ok');
    const staleCustomer = mockSocket({ customerTrackingHash: staleTracking }, 'cust-stale');

    const orderFindMany = vi.fn(async () => [{ trackingTokenHash: validTracking }]);
    const sessionFindMany = vi.fn(async () => [
      { tokenHash: digest(validUserToken), userId: 'u1', tenantId: TENANT_ID, storeId: STORE_ID },
      { tokenHash: digest(driftedRoomToken), userId: 'u2', tenantId: TENANT_ID, storeId: STORE_ID },
      { tokenHash: digest(revokedKitchenToken), userId: 'u3', tenantId: TENANT_ID, storeId: STORE_ID },
    ]);
    const membershipFindMany = vi.fn(async () => [
      { userId: 'u1', tenantId: TENANT_ID, storeId: STORE_ID, role: 'CASHIER' },
      { userId: 'u2', tenantId: TENANT_ID, storeId: STORE_ID, role: 'MANAGER' },
      { userId: 'u3', tenantId: TENANT_ID, storeId: STORE_ID, role: 'KITCHEN' },
    ]);
    const kitchenDeviceFindMany = vi.fn(async () => [
      { id: DEVICE_A, tenantId: TENANT_ID, storeId: STORE_ID, userId: 'u3', stationId: STATION_B },
    ]);

    const fakeDb = {
      order: { findMany: orderFindMany },
      session: { findMany: sessionFindMany },
      membership: { findMany: membershipFindMany },
      kitchenDevice: { findMany: kitchenDeviceFindMany },
    } as unknown as PrismaClient;

    await revalidateRealtimeSockets(
      [validEmployee, driftedEmployee, reassignedKitchen, validCustomer, staleCustomer],
      fakeDb,
    );

    expect(validEmployee.disconnect).not.toHaveBeenCalled();
    expect(validCustomer.disconnect).not.toHaveBeenCalled();
    expect(driftedEmployee.disconnect).toHaveBeenCalledTimes(1);
    expect(reassignedKitchen.disconnect).toHaveBeenCalledTimes(1);
    expect(staleCustomer.disconnect).toHaveBeenCalledTimes(1);
    expect(orderFindMany).toHaveBeenCalledTimes(1);
    expect(sessionFindMany).toHaveBeenCalledTimes(1);
    expect(membershipFindMany).toHaveBeenCalledTimes(1);
    expect(kitchenDeviceFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('Outbox batch processing, poison isolation, backoff, and clean shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes bounded jittered exponential backoff', () => {
    expect(computeBackoffMs(0, 500, 15_000, () => 0)).toBe(0);
    expect(computeBackoffMs(1, 500, 15_000, () => 1)).toBe(500);
    expect(computeBackoffMs(2, 500, 15_000, () => 0)).toBe(750);
    expect(computeBackoffMs(2, 500, 15_000, () => 1)).toBe(1_000);
    expect(computeBackoffMs(3, 500, 15_000, () => 0.5)).toBe(1_750);
    expect(computeBackoffMs(20, 500, 15_000, () => 1)).toBe(15_000);
  });

  it('quarantines invalid schema events without stalling valid events and commits partial batches on transient error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const idBad = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idOk1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const idOk2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const idOk3 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const now = new Date();
    const quarantinedIds = new Set<string>();
    const updatedIds: string[][] = [];

    const makeRow = (id: string, type: string) => ({
      id,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      type,
      aggregateId: ORDER_ID,
      version: 1,
      correlationId: 'corr-1',
      createdAt: now,
    });

    const txRows = [
      makeRow(idBad, 'corrupted.unknown.type'),
      makeRow(idOk1, 'order.accepted'),
      makeRow(idOk2, 'kitchen.item.ready'),
      makeRow(idOk3, 'kitchen.item.handed_off'),
    ];
    const fakeDb = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: vi.fn(async () => txRows),
          outbox: {
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
              updatedIds.push(where.id.in);
              return { count: where.id.in.length };
            }),
          },
        }),
    } as unknown as PrismaClient;

    let calls = 0;
    const fakeRedis = {
      publish: vi.fn(async () => {
        calls++;
        if (calls === 2) throw new Error('REDIS_DOWN');
        return 1;
      }),
    };

    const result = await processOutboxBatch({
      db: fakeDb,
      redis: fakeRedis,
      quarantinedIds,
    });

    expect(result.claimed).toBe(4);
    expect(result.quarantined).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.error?.message).toBe('REDIS_DOWN');
    expect(quarantinedIds.has(idBad)).toBe(true);
    expect(updatedIds).toEqual([[idOk1]]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs recovery after transient Redis errors and stops cleanly during backoff sleep', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let failNext = true;
    const fakeDb = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: vi.fn(async () => {
            if (failNext) throw new Error('ECONNREFUSED');
            return [];
          }),
          outbox: { updateMany: vi.fn() },
        }),
    } as unknown as PrismaClient;

    const loop = createOutboxWorkerLoop({
      db: fakeDb,
      redis: { publish: vi.fn(async () => 1) },
      baseBackoffMs: 25,
      maxBackoffMs: 50,
      pollIntervalMs: 10_000,
    });

    const firstDelay = await loop.step();
    expect(firstDelay).toBeGreaterThanOrEqual(18);
    expect(firstDelay).toBeLessThanOrEqual(50);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    failNext = false;
    const secondDelay = await loop.step();
    expect(secondDelay).toBe(10_000);
    expect(logSpy.mock.calls.some(args => String(args[0]).includes('OUTBOX_RECOVERED'))).toBe(true);

    // Start run loop and ensure stop() terminates a 10s sleep promptly.
    const startedAt = Date.now();
    const runPromise = loop.run();
    await new Promise(resolve => setTimeout(resolve, 20));
    await loop.stop(1_000);
    await runPromise;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('resolves default batch time budget inside the transaction deadline with commit headroom', () => {
    expect(resolveOutboxTiming({})).toEqual({
      publishTimeoutMs: 5_000,
      batchTimeBudgetMs: 10_000,
      transactionTimeoutMs: 15_000,
    });
    expect(resolveOutboxTiming({ batchTimeBudgetMs: 2_000, transactionTimeoutMs: 600 })).toEqual({
      publishTimeoutMs: 5_000,
      batchTimeBudgetMs: 400,
      transactionTimeoutMs: 600,
    });
    expect(resolveOutboxTiming({ publishTimeoutMs: 12_000 })).toEqual({
      publishTimeoutMs: 12_000,
      batchTimeBudgetMs: 12_000,
      transactionTimeoutMs: 17_000,
    });
  });

  it('commits slow sub-timeout publishes before transaction deadline and leaves remaining rows pending', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const rowIds = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000005',
    ];
    let pending = rowIds.map((id, idx) => ({
      id,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      type: 'order.accepted',
      aggregateId: ORDER_ID,
      version: 1,
      correlationId: `slow-${idx}`,
      createdAt: new Date(1_700_000_000_000 + idx * 1_000),
    }));

    const txTimeouts: number[] = [];
    const committedBatches: string[][] = [];
    const fakeDb = {
      $transaction: async (
        fn: (tx: unknown) => Promise<unknown>,
        opts?: { timeout?: number },
      ) => {
        if (opts?.timeout !== undefined) txTimeouts.push(opts.timeout);
        return fn({
          $queryRaw: vi.fn(async () => pending.slice()),
          outbox: {
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
              committedBatches.push(where.id.in);
              const deliveredSet = new Set(where.id.in);
              pending = pending.filter(row => !deliveredSet.has(row.id));
              return { count: where.id.in.length };
            }),
          },
        });
      },
    } as unknown as PrismaClient;

    let virtualNowMs = 0;
    const publishedIds: string[] = [];
    const slowPublisher = {
      publish: vi.fn(async (_channel: string, payload: string) => {
        // Each publish stays below the 5_000 ms per-event timeout while 5 events would exceed 15_000 ms total.
        virtualNowMs += 4_000;
        const parsed = JSON.parse(payload) as { eventId: string };
        publishedIds.push(parsed.eventId);
        return 1;
      }),
    };

    const batch1 = await processOutboxBatch({
      db: fakeDb,
      redis: slowPublisher,
      now: () => virtualNowMs,
    });

    expect(txTimeouts).toEqual([15_000]);
    expect(batch1.claimed).toBe(5);
    expect(batch1.delivered).toBe(3);
    expect(batch1.budgetExceeded).toBe(true);
    expect(batch1.error).toBeUndefined();
    expect(committedBatches).toEqual([rowIds.slice(0, 3)]);
    expect(pending.map(row => row.id)).toEqual(rowIds.slice(3));

    const batch2 = await processOutboxBatch({
      db: fakeDb,
      redis: slowPublisher,
      now: () => virtualNowMs,
    });

    expect(batch2).toEqual({ claimed: 2, delivered: 2, quarantined: 0 });
    expect(pending).toEqual([]);
    expect(publishedIds).toEqual(rowIds);
  });

  it('caps stalled publish timeout by remaining batch budget so delivered rows commit before tx deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const id1 = '20000000-0000-4000-8000-000000000001';
    const id2 = '20000000-0000-4000-8000-000000000002';
    const createdAt = new Date(1_700_000_000_000);
    let pending = [
      { id: id1, tenantId: TENANT_ID, storeId: STORE_ID, type: 'order.accepted', aggregateId: ORDER_ID, version: 1, correlationId: 'cap-1', createdAt },
      { id: id2, tenantId: TENANT_ID, storeId: STORE_ID, type: 'kitchen.item.ready', aggregateId: ORDER_ID, version: 1, correlationId: 'cap-2', createdAt },
    ];
    const committed: string[][] = [];

    const fakeDb = {
      $transaction: async (
        fn: (tx: unknown) => Promise<unknown>,
        opts?: { timeout?: number },
      ) => {
        const startedAt = Date.now();
        const res = await fn({
          $queryRaw: vi.fn(async () => pending.slice()),
          outbox: {
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
              committed.push(where.id.in);
              const set = new Set(where.id.in);
              pending = pending.filter(row => !set.has(row.id));
              return { count: where.id.in.length };
            }),
          },
        });
        expect(Date.now() - startedAt).toBeLessThan(opts?.timeout ?? 0);
        return res;
      },
    } as unknown as PrismaClient;

    let call = 0;
    const stallingRedis = {
      publish: vi.fn(
        () =>
          new Promise<number>(resolve => {
            call++;
            setTimeout(() => resolve(1), call === 1 ? 80 : 2_000);
          }),
      ),
    };

    const batchPromise = processOutboxBatch({
      db: fakeDb,
      redis: stallingRedis,
      publishTimeoutMs: 5_000,
      batchTimeBudgetMs: 120,
      transactionTimeoutMs: 400,
    });

    await vi.advanceTimersByTimeAsync(120);
    const result = await batchPromise;

    expect(result.claimed).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.budgetExceeded).toBe(true);
    expect(result.error).toBeUndefined();
    expect(committed).toEqual([[id1]]);
    expect(pending.map(row => row.id)).toEqual([id2]);
  });

  it('drains partial-budget backlog immediately when progress occurs and backs off on zero-progress budget expiry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let scenario: 'progress' | 'stalled' = 'progress';
    let clockMs = 0;
    const rows = [
      {
        id: '30000000-0000-4000-8000-000000000001',
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'order.accepted',
        aggregateId: ORDER_ID,
        version: 1,
        correlationId: 'loop-1',
        createdAt: new Date(1_700_000_000_000),
      },
      {
        id: '30000000-0000-4000-8000-000000000002',
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'kitchen.item.ready',
        aggregateId: ORDER_ID,
        version: 1,
        correlationId: 'loop-2',
        createdAt: new Date(1_700_000_001_000),
      },
    ];

    const fakeDb = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const result = await fn({
          $queryRaw: vi.fn(async () => {
            if (scenario === 'stalled') {
              // Simulate slow SELECT consuming the entire batch budget before event 1 starts.
              clockMs += 200;
            }
            return rows.slice();
          }),
          outbox: { updateMany: vi.fn(async () => ({ count: 1 })) },
        });
        return result;
      },
    } as unknown as PrismaClient;

    const loop = createOutboxWorkerLoop({
      db: fakeDb,
      redis: {
        publish: vi.fn(async () => {
          clockMs += 150;
          return 1;
        }),
      },
      batchSize: 10,
      pollIntervalMs: 5_000,
      baseBackoffMs: 100,
      maxBackoffMs: 200,
      batchTimeBudgetMs: 100,
      transactionTimeoutMs: 500,
      now: () => clockMs,
    });

    // Event 1 completes (+150ms > 100ms budget), so event 2 pauses under budget and drains at delay 0.
    const progressDelay = await loop.step();
    expect(progressDelay).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();

    // When zero events finish before budget expiry, worker backs off rather than tight-looping at 0 ms.
    scenario = 'stalled';
    const stalledDelay = await loop.step();
    expect(stalledDelay).toBeGreaterThanOrEqual(75);
    expect(stalledDelay).toBeLessThanOrEqual(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

function createInMemoryRedisBroker() {
  const exactSubs = new Map<string, Set<InMemoryMockRedis>>();
  const patternSubs = new Map<string, Set<InMemoryMockRedis>>();

  const patternToRegex = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

  class InMemoryMockRedis extends EventEmitter implements RealtimeRedisLike {
    status = 'connecting';
    isCluster = false;
    private readonly channels = new Set<string>();
    private readonly patterns = new Set<string>();
    public psubscribeError: Error | null = null;
    public publishError: Error | null = null;

    async subscribe(...args: unknown[]) {
      const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      for (const ch of list) {
        if (typeof ch !== 'string') continue;
        this.channels.add(ch);
        if (!exactSubs.has(ch)) exactSubs.set(ch, new Set());
        exactSubs.get(ch)!.add(this);
      }
      return this.channels.size;
    }

    async unsubscribe(...args: unknown[]) {
      const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      for (const ch of list) {
        if (typeof ch !== 'string') continue;
        this.channels.delete(ch);
        exactSubs.get(ch)?.delete(this);
      }
      return 0;
    }

    async psubscribe(...args: unknown[]) {
      if (this.psubscribeError) throw this.psubscribeError;
      const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      for (const pat of list) {
        if (typeof pat !== 'string') continue;
        this.patterns.add(pat);
        if (!patternSubs.has(pat)) patternSubs.set(pat, new Set());
        patternSubs.get(pat)!.add(this);
      }
      return this.patterns.size;
    }

    async punsubscribe(...args: unknown[]) {
      const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      for (const pat of list) {
        if (typeof pat !== 'string') continue;
        this.patterns.delete(pat);
        patternSubs.get(pat)?.delete(this);
      }
      return 0;
    }

    async publish(channel: string, message: string | Buffer): Promise<number> {
      if (this.publishError) throw this.publishError;
      let count = 0;
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
      for (const sub of exactSubs.get(channel) ?? []) {
        sub.emit('message', channel, buf.toString('utf8'));
        sub.emit('messageBuffer', Buffer.from(channel), buf);
        count++;
      }
      for (const [pattern, subs] of patternSubs.entries()) {
        if (patternToRegex(pattern).test(channel)) {
          for (const sub of subs) {
            sub.emit('pmessage', pattern, channel, buf.toString('utf8'));
            sub.emit('pmessageBuffer', Buffer.from(pattern), Buffer.from(channel), buf);
            count++;
          }
        }
      }
      return count;
    }

    send_command(_command: string, args: unknown[], callback?: (err: Error | null, res?: unknown) => void) {
      const ch = String(args[1] ?? '');
      const count = exactSubs.get(ch)?.size ?? 0;
      callback?.(null, [ch, count]);
    }

    emitReady() {
      this.status = 'ready';
      this.emit('ready');
    }

    emitDisconnect(err: Error) {
      this.status = 'reconnecting';
      this.emit('error', err);
      this.emit('close');
    }

    async quit() {
      this.status = 'end';
      this.disconnect();
      return 'OK';
    }

    disconnect() {
      this.status = 'end';
      for (const ch of this.channels) exactSubs.get(ch)?.delete(this);
      for (const pat of this.patterns) patternSubs.get(pat)?.delete(this);
      this.emit('end');
    }
  }

  return {
    publishRaw: async (channel: string, payload: string) => {
      const pub = new InMemoryMockRedis();
      return pub.publish(channel, payload);
    },
    createClient: () => new InMemoryMockRedis(),
  };
}

describe('M2-T09: Socket.IO Redis adapter resilience, deduplication, ACL safety, and multi-instance bridge', () => {
  afterEach(() => {
    setRealtimeRedisHealthProbe(undefined);
    vi.restoreAllMocks();
  });

  it('bounds event deduplicator size and preserves FIFO eviction order', () => {
    const deduper = createEventDeduplicator(2);
    deduper.mark('evt-1');
    deduper.mark('evt-2');
    expect(deduper.has('evt-1')).toBe(true);
    expect(deduper.has('evt-2')).toBe(true);

    deduper.mark('evt-3');
    expect(deduper.size).toBe(2);
    expect(deduper.has('evt-1')).toBe(false);
    expect(deduper.has('evt-2')).toBe(true);
    expect(deduper.has('evt-3')).toBe(true);
  });

  it('tracks honest subscriber/adapter readiness, handles ACL NOPERM cleanly, and recovers on reconnect', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const broker = createInMemoryRedisBroker();
    const metrics = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });
    const roles: Record<string, ReturnType<typeof broker.createClient>> = {};
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const close = attachRealtime(server, 'http://localhost:3000', {
      metrics,
      database: {} as unknown as PrismaClient,
      createRedisClient: (_url, _opts, role) => {
        const c = broker.createClient();
        roles[role] = c;
        if (role === 'adapter_sub') {
          c.psubscribeError = new Error('NOPERM this user has no permissions to run psubscribe');
        }
        return c;
      },
    });

    try {
      // Slow startup: probe must remain false before Redis clients connect & subscribe.
      expect(await realtimeRedisReady()).toBe(false);

      // ACL NOPERM on adapter_sub must never crash the process and must keep readiness false.
      roles.events_sub!.emitReady();
      roles.adapter_pub!.emitReady();
      roles.adapter_sub!.emitReady();
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(await realtimeRedisReady()).toBe(false);
      expect(errSpy.mock.calls.some(args => String(args[0]).includes('REALTIME_ADAPTER_SUBSCRIPTION_FAILED'))).toBe(true);

      // Clearing ACL error and reconnecting makes readiness turn honest true once psubscribe + subscribe succeed.
      roles.adapter_sub!.psubscribeError = null;
      roles.adapter_sub!.emitDisconnect(new Error('reconnecting'));
      roles.adapter_sub!.emitReady();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(await realtimeRedisReady()).toBe(true);

      // Simulate events_sub disconnect -> logs once, drops readiness false, and recovers on ready.
      roles.events_sub!.emitDisconnect(new Error('ECONNRESET'));
      expect(await realtimeRedisReady()).toBe(false);
      expect(warnSpy.mock.calls.some(args => String(args[0]).includes('REALTIME_REDIS_UNAVAILABLE'))).toBe(true);

      // Fast-path publish returns false cleanly during pub outage (never throws UnhandledPromiseRejection).
      roles.adapter_pub!.publishError = new Error('NOPERM publish denied');
      const pubOk = await publishRealtimeOperationalEvent({
        eventId: '99999999-9999-4999-8999-999999999999',
        schemaVersion: 1,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'order.accepted',
        aggregateId: ORDER_ID,
        version: 1,
        occurredAt: new Date().toISOString(),
      });
      expect(pubOk).toBe(false);

      roles.adapter_pub!.publishError = null;
      roles.events_sub!.emitReady();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(await realtimeRedisReady()).toBe(true);

      const text = await metrics.render();
      expect(text).toContain('realtime_adapter_ready{service="omnihub-api"} 1');
      expect(text).toContain('realtime_adapter_errors_total{component="acl",service="omnihub-api"}');
    } finally {
      await close();
      expect(await realtimeRedisReady()).toBe(true);
      await new Promise<void>(resolve => server.close(() => resolve()));
      metrics.close();
    }
  });

  it('isolates tenants, deduplicates retried broadcasts, and revokes sessions & kitchen devices across two API replicas', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const USER_A = '91111111-1111-4111-8111-111111111111';
    const USER_CASHIER = '92222222-2222-4222-8222-222222222222';
    const USER_KITCHEN = '93333333-3333-4333-8333-333333333333';
    const USER_B = '94444444-4444-4444-8444-444444444444';

    const broker = createInMemoryRedisBroker();
    const metricsA = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });
    const metricsB = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });

    const tokenA1 = 'a'.repeat(64);
    const tokenA2 = 'b'.repeat(64);
    const tokenCashier = 'c'.repeat(64);
    const tokenKitchen = 'd'.repeat(64);
    const tokenTenantB = 'e'.repeat(64);

    let activeSessions = new Set([digest(tokenA1), digest(tokenA2), digest(tokenCashier), digest(tokenKitchen), digest(tokenTenantB)]);
    let kitchenStation: string | null = STATION_A;
    let kitchenRevoked = false;

    const makeMockDb = () =>
      ({
        session: {
          findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
            if (!activeSessions.has(where.tokenHash)) return null;
            if (where.tokenHash === digest(tokenTenantB)) {
              return { tokenHash: where.tokenHash, userId: USER_B, tenantId: OTHER_STORE_ID, storeId: OTHER_STORE_ID, expiresAt: new Date(Date.now() + 60_000), user: { active: true } };
            }
            const userId = where.tokenHash === digest(tokenCashier)
              ? USER_CASHIER
              : where.tokenHash === digest(tokenKitchen)
                ? USER_KITCHEN
                : USER_A;
            return { tokenHash: where.tokenHash, userId, tenantId: TENANT_ID, storeId: STORE_ID, expiresAt: new Date(Date.now() + 60_000), user: { active: true } };
          }),
          findMany: vi.fn(async ({ where }: { where: { tokenHash: { in: string[] } } }) =>
            where.tokenHash.in
              .filter(h => activeSessions.has(h))
              .map(h => {
                if (h === digest(tokenTenantB)) {
                  return { tokenHash: h, userId: USER_B, tenantId: OTHER_STORE_ID, storeId: OTHER_STORE_ID };
                }
                const userId = h === digest(tokenCashier) ? USER_CASHIER : h === digest(tokenKitchen) ? USER_KITCHEN : USER_A;
                return { tokenHash: h, userId, tenantId: TENANT_ID, storeId: STORE_ID };
              }),
          ),
        },
        membership: {
          findUnique: vi.fn(async ({ where }: { where: { userId_storeId: { userId: string; storeId: string } } }) => {
            if (where.userId_storeId.userId === USER_B) return { tenantId: OTHER_STORE_ID, storeId: OTHER_STORE_ID, userId: USER_B, role: 'OWNER' };
            if (where.userId_storeId.userId === USER_KITCHEN) return { tenantId: TENANT_ID, storeId: STORE_ID, userId: USER_KITCHEN, role: 'KITCHEN' };
            return { tenantId: TENANT_ID, storeId: STORE_ID, userId: where.userId_storeId.userId, role: 'CASHIER' };
          }),
          findMany: vi.fn(async () => [
            { userId: USER_A, tenantId: TENANT_ID, storeId: STORE_ID, role: 'CASHIER' },
            { userId: USER_CASHIER, tenantId: TENANT_ID, storeId: STORE_ID, role: 'CASHIER' },
            { userId: USER_KITCHEN, tenantId: TENANT_ID, storeId: STORE_ID, role: 'KITCHEN' },
            { userId: USER_B, tenantId: OTHER_STORE_ID, storeId: OTHER_STORE_ID, role: 'OWNER' },
          ]),
        },
        kitchenDevice: {
          findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
            kitchenRevoked || where.id !== DEVICE_A ? null : { id: DEVICE_A, stationId: kitchenStation },
          ),
          findMany: vi.fn(async () =>
            kitchenRevoked ? [] : [{ id: DEVICE_A, tenantId: TENANT_ID, storeId: STORE_ID, userId: USER_KITCHEN, stationId: kitchenStation }],
          ),
        },
        kitchenTicket: {
          findMany: vi.fn(async () => [{ stationId: STATION_A }]),
        },
        order: { findMany: vi.fn(async () => []) },
      }) as unknown as PrismaClient;

    const startInstance = async (metrics: ReturnType<typeof createMetricsRegistry>) => {
      const server: HttpServer = createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const close = attachRealtime(server, 'http://localhost:3000', {
        database: makeMockDb(),
        metrics,
        createRedisClient: () => {
          const client = broker.createClient();
          queueMicrotask(() => client.emitReady());
          return client;
        },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      return { baseUrl: `http://127.0.0.1:${port}`, server, close };
    };

    const repA = await startInstance(metricsA);
    const repB = await startInstance(metricsB);

    const connectClient = (baseUrl: string, token: string, deviceId?: string) =>
      new Promise<ClientSocket>((resolve, reject) => {
        const sock = createSocketClient(baseUrl, {
          transports: ['websocket'],
          reconnection: false,
          extraHeaders: { origin: 'http://localhost:3000', cookie: `session=${token}` },
          auth: deviceId ? { deviceId } : undefined,
        });
        sock.once('connect', () => resolve(sock));
        sock.once('connect_error', reject);
      });

    const clientA1 = await connectClient(repA.baseUrl, tokenA1);
    const clientA2 = await connectClient(repB.baseUrl, tokenA2);
    const clientCashierB = await connectClient(repB.baseUrl, tokenCashier);
    const clientKitchenB = await connectClient(repB.baseUrl, tokenKitchen, DEVICE_A);
    const clientTenantB = await connectClient(repB.baseUrl, tokenTenantB);

    const receivedA1: string[] = [];
    const receivedCashierB: string[] = [];
    const receivedTenantB: string[] = [];
    clientA1.on('operational.event', (e: { type: string }) => receivedA1.push(e.type));
    clientCashierB.on('operational.event', (e: { type: string }) => receivedCashierB.push(e.type));
    clientTenantB.on('operational.event', (e: { type: string }) => receivedTenantB.push(e.type));

    try {
      // 1. Outbox broadcast reaches authorized Tenant A clients across replicas once; duplicate eventId is deduplicated; Tenant B gets 0.
      const orderEvent = {
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        schemaVersion: 1,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'order.accepted',
        aggregateId: ORDER_ID,
        version: 1,
        occurredAt: new Date().toISOString(),
      };
      await broker.publishRaw('omnihub.events', JSON.stringify(orderEvent));
      await broker.publishRaw('omnihub.events', JSON.stringify(orderEvent));
      await new Promise(resolve => setTimeout(resolve, 40));

      expect(receivedA1).toEqual(['order.accepted']);
      expect(receivedCashierB).toEqual(['order.accepted']);
      expect(receivedTenantB).toEqual([]);
      expect(await metricsB.render()).toContain('realtime_events_broadcast_total{outcome="deduplicated",service="omnihub-api"} 1');

      // 2. Revoke only tokenA1 on session.revoked -> clientA1 disconnects immediately, while tokenA2, cashier, & tenantB stay connected and see zero leaked session events.
      activeSessions = new Set([digest(tokenA2), digest(tokenCashier), digest(tokenKitchen), digest(tokenTenantB)]);
      const a1Disconnected = new Promise<void>(resolve => clientA1.once('disconnect', () => resolve()));
      await publishRealtimeOperationalEvent({
        eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        schemaVersion: 1,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'session.revoked',
        aggregateId: USER_A,
        version: 1,
        occurredAt: new Date().toISOString(),
      });
      await Promise.race([
        a1Disconnected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('STEP2_A1_DISCONNECT_TIMEOUT')), 1500)),
      ]);
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(clientA1.connected).toBe(false);
      expect(clientA2.connected).toBe(true);
      expect(clientCashierB.connected).toBe(true);
      expect(clientTenantB.connected).toBe(true);
      expect(receivedCashierB).toEqual(['order.accepted']);

      // 3. Reassign / revoke kitchen device -> clientKitchenB on replica B disconnects immediately.
      kitchenStation = STATION_B;
      kitchenRevoked = true;
      const kitchenDisconnected = new Promise<void>(resolve => clientKitchenB.once('disconnect', () => resolve()));
      await broker.publishRaw('omnihub.events', JSON.stringify({
        eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        schemaVersion: 1,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        type: 'kitchen.device.changed',
        aggregateId: DEVICE_A,
        version: 1,
        occurredAt: new Date().toISOString(),
      }));
      await Promise.race([
        kitchenDisconnected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('STEP3_KITCHEN_DISCONNECT_TIMEOUT')), 1500)),
      ]);
      expect(clientKitchenB.connected).toBe(false);

      // 4. Rejects unauthorized custom namespaces to preserve single-namespace isolation.
      await expect(
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            badNs.close();
            reject(new Error('STEP4_BAD_NS_TIMEOUT'));
          }, 1500);
          const badNs = createSocketClient(`${repA.baseUrl}/admin`, {
            transports: ['websocket'],
            reconnection: false,
            extraHeaders: { origin: 'http://localhost:3000', cookie: `session=${tokenA2}` },
          });
          badNs.once('connect', () => {
            clearTimeout(timer);
            badNs.close();
            resolve();
          });
          badNs.once('connect_error', err => {
            clearTimeout(timer);
            badNs.close();
            reject(err);
          });
        }),
      ).rejects.toThrow();
    } finally {
      for (const s of [clientA1, clientA2, clientCashierB, clientKitchenB, clientTenantB]) s.close();
      await repA.close();
      await repB.close();
      await Promise.all([
        new Promise<void>(resolve => repA.server.close(() => resolve())),
        new Promise<void>(resolve => repB.server.close(() => resolve())),
      ]);
      metricsA.close();
      metricsB.close();
    }
  });
});
