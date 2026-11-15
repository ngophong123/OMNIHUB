import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../../apps/api/src/domain';
import { computeBackoffMs, createOutboxWorkerLoop, processOutboxBatch } from '../../apps/api/src/outbox';
import {
  broadcastOperationalEvent,
  extractCookieValue,
  revalidateRealtimeSockets,
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
});
