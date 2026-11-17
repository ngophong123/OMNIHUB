import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../apps/api/src/database';
import { digest, hashPassword } from '../../apps/api/src/domain';
import { processOutboxBatch } from '../../apps/api/src/outbox';
import { setRateLimitRedisHealthProbe } from '../../apps/api/src/rate-limit';
import {
  broadcastOperationalEvent,
  revalidateRealtimeSockets,
  setRealtimeRedisHealthProbe,
  type RealtimeServerLike,
  type RealtimeSocketLike,
} from '../../apps/api/src/realtime';

type ConfiguredHttpApp = {
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): http.Server;
  close(): Promise<void>;
};

const TEST_ORIGIN = 'http://localhost:3000';

type RawHttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawHttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          Connection: 'close',
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('Realtime readiness probe & transactional session/device revocation (M2-T09 PostgreSQL)', () => {
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const ownerId = randomUUID();
  const kitchenUserId = randomUUID();
  const stationA = randomUUID();
  const stationB = randomUUID();
  const deviceId = randomUUID();

  const ownerTokenA = randomBytes(32).toString('hex');
  const ownerTokenB = randomBytes(32).toString('hex');
  const kitchenToken = randomBytes(32).toString('hex');

  let app: ConfiguredHttpApp;
  let baseUrl = '';

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, name: 'Realtime Revoke Tenant' } });
    await db.store.create({ data: { id: storeId, tenantId, name: 'Realtime Revoke Store' } });
    await db.user.createMany({
      data: [
        { id: ownerId, email: `rt-owner-${tenantId}@omnihub.test`, passwordHash: hashPassword('OwnerPass123!'), active: true },
        { id: kitchenUserId, email: `rt-kitchen-${tenantId}@omnihub.test`, passwordHash: hashPassword('KitchenPass123!'), active: true },
      ],
    });
    await db.membership.createMany({
      data: [
        { tenantId, storeId, userId: ownerId, role: 'OWNER' },
        { tenantId, storeId, userId: kitchenUserId, role: 'KITCHEN' },
      ],
    });
    const expiresAt = new Date(Date.now() + 3600_000);
    await db.session.createMany({
      data: [
        { tokenHash: digest(ownerTokenA), tenantId, storeId, userId: ownerId, expiresAt },
        { tokenHash: digest(ownerTokenB), tenantId, storeId, userId: ownerId, expiresAt },
        { tokenHash: digest(kitchenToken), tenantId, storeId, userId: kitchenUserId, expiresAt },
      ],
    });
    await db.station.createMany({
      data: [
        { id: stationA, tenantId, storeId, name: 'Hot Line', active: true },
        { id: stationB, tenantId, storeId, name: 'Cold Line', active: true },
      ],
    });
    await db.kitchenDevice.create({
      data: { id: deviceId, tenantId, storeId, userId: kitchenUserId, stationId: stationA },
    });

    const httpAppModuleId = ['..', '..', 'apps', 'api', 'src', 'http-app'].join('/');
    const { createConfiguredHttpApp } = (await import(httpAppModuleId)) as {
      createConfiguredHttpApp: (options?: { origin?: string; enableAccessLogs?: boolean }) => Promise<ConfiguredHttpApp>;
    };
    app = await createConfiguredHttpApp({ origin: TEST_ORIGIN, enableAccessLogs: false });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    setRealtimeRedisHealthProbe(undefined);
    if (app) await app.close();
    await db.outbox.deleteMany({ where: { tenantId } });
    await db.session.deleteMany({ where: { tenantId } });
    await db.$disconnect();
  });

  it('gates GET /ready on realtime Redis subscriber readiness and persists Outbox events on logout and kitchen device changes', async () => {
    // 1. /ready fails closed with 503 REDIS_REQUIRED_FOR_REALTIME when realtime subscriber/adapter is unready.
    setRateLimitRedisHealthProbe(async () => 'PONG');
    setRealtimeRedisHealthProbe(() => false);
    const notReady = await httpRequest(baseUrl, 'GET', '/ready');
    expect(notReady.status).toBe(503);
    expect(JSON.parse(notReady.body)).toMatchObject({ code: 'REDIS_REQUIRED_FOR_REALTIME' });

    setRealtimeRedisHealthProbe(() => true);
    const readyRes = await httpRequest(baseUrl, 'GET', '/ready');
    expect(readyRes.status).toBe(200);
    expect(JSON.parse(readyRes.body)).toMatchObject({ database: 'ok', redis: 'ok', realtime: 'ok' });

    const makeMockSocket = (data: Record<string, unknown>, id: string): RealtimeSocketLike & {
      emitted: unknown[];
      disconnected: boolean;
    } => {
      const sock = {
        id,
        data,
        emitted: [] as unknown[],
        disconnected: false,
        emit: (event: string, ...args: unknown[]) => sock.emitted.push({ event, args }),
        disconnect: () => {
          sock.disconnected = true;
        },
      };
      return sock;
    };

    const ownerSockA = makeMockSocket({ tokenHash: digest(ownerTokenA), room: `${tenantId}:${storeId}` }, 'owner-a');
    const ownerSockB = makeMockSocket({ tokenHash: digest(ownerTokenB), room: `${tenantId}:${storeId}` }, 'owner-b');
    const kitchenSock = makeMockSocket({ tokenHash: digest(kitchenToken), room: `${tenantId}:${storeId}`, deviceId, stationId: stationA }, 'kitchen-1');

    const ioMock: RealtimeServerLike = {
      to: () => ({ emit: () => undefined }),
      in: () => ({ fetchSockets: async () => [ownerSockA, ownerSockB, kitchenSock].filter(s => !s.disconnected) }),
    };

    // 2. POST /auth/logout deletes only ownerTokenA and appends Outbox session.revoked atomically.
    const logoutRes = await httpRequest(baseUrl, 'POST', '/auth/logout', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerTokenA}`,
    });
    expect(logoutRes.status).toBe(201);

    const published: string[] = [];
    const batch1 = await processOutboxBatch({
      db,
      tenantIds: [tenantId],
      redis: {
        publish: vi.fn(async (_ch, payload) => {
          published.push(payload);
          return 1;
        }),
      },
    });
    expect(batch1.quarantined).toBe(0);
    expect(batch1.delivered).toBe(1);
    const sessionEvent = JSON.parse(published[0]!) as Parameters<typeof broadcastOperationalEvent>[2];
    expect(sessionEvent.type).toBe('session.revoked');
    expect(sessionEvent.aggregateId).toBe(ownerId);

    // Broadcast disconnects only ownerSockA and discloses zero session events to ownerSockB or kitchenSock.
    await broadcastOperationalEvent(ioMock, db, sessionEvent);
    expect(ownerSockA.disconnected).toBe(true);
    expect(ownerSockB.disconnected).toBe(false);
    expect(ownerSockB.emitted).toEqual([]);
    expect(kitchenSock.disconnected).toBe(false);

    // 3. PUT /admin/kitchen/devices/:id/assignment writes kitchen.device.changed to Outbox and disconnects stale-station kitchen socket.
    const reassignRes = await httpRequest(
      baseUrl,
      'PUT',
      `/admin/kitchen/devices/${deviceId}/assignment`,
      {
        Origin: TEST_ORIGIN,
        Cookie: `session=${ownerTokenB}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ stationId: stationB }),
    );
    expect(reassignRes.status).toBe(200);

    const batch2 = await processOutboxBatch({
      db,
      tenantIds: [tenantId],
      redis: {
        publish: vi.fn(async (_ch, payload) => {
          published.push(payload);
          return 1;
        }),
      },
    });
    expect(batch2.quarantined).toBe(0);
    expect(batch2.delivered).toBe(1);
    const assignEvent = JSON.parse(published[1]!) as Parameters<typeof broadcastOperationalEvent>[2];
    expect(assignEvent.type).toBe('kitchen.device.changed');
    expect(assignEvent.aggregateId).toBe(deviceId);

    await broadcastOperationalEvent(ioMock, db, assignEvent);
    expect(kitchenSock.disconnected).toBe(true);
    expect(ownerSockB.disconnected).toBe(false);
    expect(ownerSockB.emitted.some(e => (e as { event: string }).event === 'operational.event')).toBe(true);

    // 4. POST /admin/kitchen/devices/:id/revoke also writes Outbox kitchen.device.changed and blocks reconnected socket on revalidation.
    const revokeRes = await httpRequest(baseUrl, 'POST', `/admin/kitchen/devices/${deviceId}/revoke`, {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerTokenB}`,
    });
    expect(revokeRes.status).toBe(201);

    const staleReconnectedKitchen = makeMockSocket({ tokenHash: digest(kitchenToken), room: `${tenantId}:${storeId}`, deviceId, stationId: stationB }, 'kitchen-reconnected');
    await revalidateRealtimeSockets([ownerSockB, staleReconnectedKitchen], db);
    expect(staleReconnectedKitchen.disconnected).toBe(true);
    expect(ownerSockB.disconnected).toBe(false);
  });

  it('retries PostgreSQL P2034 serialization conflict during concurrent kitchen device heartbeat and revocation without duplicates or bypasses', async () => {
    const concurrentDeviceId = randomUUID();
    const burstDeviceId = randomUUID();

    // 1. Register a kitchen device via the HTTP endpoint.
    const initialReg = await httpRequest(
      baseUrl,
      'POST',
      '/kitchen/devices/register',
      {
        Origin: TEST_ORIGIN,
        Cookie: `session=${kitchenToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ deviceId: concurrentDeviceId }),
    );
    expect(initialReg.status).toBe(201);

    // 2-3. Deterministically overlap a heartbeat (/kitchen/devices/register) committing
    // lastSeenAt with revokeKitchenDevice's first Serializable attempt so PostgreSQL
    // throws a real SQLSTATE 40001 / Prisma P2034 conflict on revoke attempt #1.
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>(r => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const heartbeatInsideTx = deferred<void>();
    const allowHeartbeatCommit = deferred<void>();
    let observedP2034 = false;
    let revokeTxAttempts = 0;

    const origTx = db.$transaction.bind(db);
    let registerDone!: Promise<RawHttpResponse>;

    const txSpy = vi.spyOn(db, '$transaction').mockImplementation((async (
      fnOrArray: unknown,
      options?: unknown,
    ) => {
      if (typeof fnOrArray !== 'function') {
        return origTx(fnOrArray as never, options as never);
      }
      const callback = fnOrArray as (tx: unknown) => Promise<unknown>;
      const callIdx = txSpy.mock.calls.length;

      // Call #1 belongs to the in-flight heartbeat (/kitchen/devices/register).
      if (callIdx === 1) {
        return origTx(async tx => {
          const result = await callback(tx);
          heartbeatInsideTx.resolve();
          await allowHeartbeatCommit.promise;
          return result;
        }, options as never);
      }

      // Call #2 belongs to revokeKitchenDevice attempt #1; capture its Serializable snapshot
      // via reauthorize before letting heartbeat commit, then execute UPDATE to trigger real P2034.
      if (callIdx === 2) {
        revokeTxAttempts += 1;
        try {
          return await origTx(async tx => {
            const rawTx = tx as Record<PropertyKey, unknown>;
            const proxiedTx = new Proxy(rawTx, {
              get(target, prop, receiver) {
                if (prop === 'kitchenDevice') {
                  const kd = target.kitchenDevice as { updateMany: (...args: unknown[]) => Promise<unknown> };
                  return new Proxy(kd, {
                    get(kdTarget, kdProp, kdReceiver) {
                      if (kdProp === 'updateMany') {
                        return async (...args: unknown[]) => {
                          allowHeartbeatCommit.resolve();
                          await registerDone;
                          return kdTarget.updateMany(...args);
                        };
                      }
                      return Reflect.get(kdTarget, kdProp, kdReceiver);
                    },
                  });
                }
                return Reflect.get(target, prop, receiver);
              },
            });
            return callback(proxiedTx);
          }, options as never);
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'P2034') {
            observedP2034 = true;
          }
          throw err;
        }
      }

      // Call #3 belongs to the automatic P2034 retry of revokeKitchenDevice.
      revokeTxAttempts += 1;
      return origTx(callback as never, options as never);
    }) as typeof db.$transaction);

    let revokeResponse: RawHttpResponse;
    let heartbeatResponse: RawHttpResponse;
    try {
      registerDone = httpRequest(
        baseUrl,
        'POST',
        '/kitchen/devices/register',
        {
          Origin: TEST_ORIGIN,
          Cookie: `session=${kitchenToken}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ deviceId: concurrentDeviceId }),
      );
      await heartbeatInsideTx.promise;

      const revokePromise = httpRequest(baseUrl, 'POST', `/admin/kitchen/devices/${concurrentDeviceId}/revoke`, {
        Origin: TEST_ORIGIN,
        Cookie: `session=${ownerTokenB}`,
      });

      [heartbeatResponse, revokeResponse] = await Promise.all([registerDone, revokePromise]);
    } finally {
      txSpy.mockRestore();
    }

    // 4-5. Confirm real PostgreSQL P2034 was triggered and recovered via retry without 500/409.
    expect(observedP2034).toBe(true);
    expect(revokeTxAttempts).toBe(2);
    expect(heartbeatResponse!.status).toBe(201);
    expect(revokeResponse!.status).toBe(201);
    expect(JSON.parse(revokeResponse!.body)).toEqual({ id: concurrentDeviceId, revoked: true });

    // Also exercise uninstrumented concurrent heartbeat + revoke burst on a second device.
    const burstInitial = await httpRequest(
      baseUrl,
      'POST',
      '/kitchen/devices/register',
      {
        Origin: TEST_ORIGIN,
        Cookie: `session=${kitchenToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({ deviceId: burstDeviceId }),
    );
    expect(burstInitial.status).toBe(201);

    const [burstRevoke, ...burstHeartbeats] = await Promise.all([
      httpRequest(baseUrl, 'POST', `/admin/kitchen/devices/${burstDeviceId}/revoke`, {
        Origin: TEST_ORIGIN,
        Cookie: `session=${ownerTokenB}`,
      }),
      ...Array.from({ length: 4 }, () =>
        httpRequest(
          baseUrl,
          'POST',
          '/kitchen/devices/register',
          {
            Origin: TEST_ORIGIN,
            Cookie: `session=${kitchenToken}`,
            'Content-Type': 'application/json',
          },
          JSON.stringify({ deviceId: burstDeviceId }),
        ),
      ),
    ]);

    expect(burstRevoke.status).toBe(201);
    for (const hb of burstHeartbeats) {
      expect([201, 403]).toContain(hb.status);
    }

    // 6-7. Verify revokedAt persisted and strictly 1 Audit + 1 Outbox event created per revoked device.
    for (const targetDeviceId of [concurrentDeviceId, burstDeviceId]) {
      const persisted = await db.kitchenDevice.findUnique({ where: { id: targetDeviceId } });
      expect(persisted).not.toBeNull();
      expect(persisted!.revokedAt).toBeInstanceOf(Date);

      const revokeAudits = await db.audit.findMany({
        where: { tenantId, entityId: targetDeviceId, action: 'KITCHEN_DEVICE_REVOKED' },
      });
      expect(revokeAudits).toHaveLength(1);

      const revokeOutbox = await db.outbox.findMany({
        where: { tenantId, aggregateId: targetDeviceId, type: 'kitchen.device.changed' },
      });
      expect(revokeOutbox).toHaveLength(1);
    }

    // Drain Outbox and confirm kitchen.device.changed broadcasts disconnect any connected device socket.
    const publishedRevocations: string[] = [];
    const batchRevoke = await processOutboxBatch({
      db,
      tenantIds: [tenantId],
      redis: {
        publish: vi.fn(async (_ch, payload) => {
          publishedRevocations.push(payload);
          return 1;
        }),
      },
    });
    expect(batchRevoke.quarantined).toBe(0);
    expect(batchRevoke.delivered).toBeGreaterThanOrEqual(2);
    const concurrentRevokeMsg = publishedRevocations
      .map(p => JSON.parse(p) as Parameters<typeof broadcastOperationalEvent>[2])
      .find(msg => msg.type === 'kitchen.device.changed' && msg.aggregateId === concurrentDeviceId);
    expect(concurrentRevokeMsg).toBeDefined();

    for (const targetDeviceId of [concurrentDeviceId, burstDeviceId]) {

      // 8. Re-registration and station reassignment must be rejected after revocation without clearing revokedAt.
      const reregisterRes = await httpRequest(
        baseUrl,
        'POST',
        '/kitchen/devices/register',
        {
          Origin: TEST_ORIGIN,
          Cookie: `session=${kitchenToken}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ deviceId: targetDeviceId }),
      );
      expect(reregisterRes.status).toBe(403);
      expect(JSON.parse(reregisterRes.body)).toMatchObject({ code: 'KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE' });

      const reassignAfterRevoke = await httpRequest(
        baseUrl,
        'PUT',
        `/admin/kitchen/devices/${targetDeviceId}/assignment`,
        {
          Origin: TEST_ORIGIN,
          Cookie: `session=${ownerTokenB}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({ stationId: stationB }),
      );
      expect(reassignAfterRevoke.status).toBe(404);

      const afterRejects = await db.kitchenDevice.findUnique({ where: { id: targetDeviceId } });
      expect(afterRejects!.revokedAt).not.toBeNull();
      expect(afterRejects!.stationId).toBeNull();

      // 9. Revoked device cannot sync offline commands or reconnect/stay connected on Socket.IO.
      const syncRes = await httpRequest(
        baseUrl,
        'POST',
        '/kitchen/sync',
        {
          Origin: TEST_ORIGIN,
          Cookie: `session=${kitchenToken}`,
          'X-Kitchen-Device': targetDeviceId,
          'Content-Type': 'application/json',
        },
        JSON.stringify({
          commands: [
            {
              commandId: randomUUID(),
              tenantId,
              storeId,
              userId: kitchenUserId,
              deviceId: targetDeviceId,
              sequence: 1,
              orderId: randomUUID(),
              itemId: randomUUID(),
              expectedVersion: 1,
              action: 'START',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
      expect(syncRes.status).toBe(403);
      expect(JSON.parse(syncRes.body)).toMatchObject({ code: 'KITCHEN_DEVICE_NOT_AUTHORIZED' });

      const revokedSocket = {
        id: `revoked-${targetDeviceId}`,
        data: { tokenHash: digest(kitchenToken), room: `${tenantId}:${storeId}`, deviceId: targetDeviceId, stationId: null },
        disconnected: false,
        emit: () => undefined,
        disconnect: () => {
          revokedSocket.disconnected = true;
        },
      };
      await revalidateRealtimeSockets([revokedSocket], db);
      expect(revokedSocket.disconnected).toBe(true);
    }
  });
});
