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
    const sessionEvent = JSON.parse(published[0]!) as {
      eventId: string;
      schemaVersion: 1;
      tenantId: string;
      storeId: string;
      type: 'session.revoked';
      aggregateId: string;
      version: number;
      occurredAt: string;
    };
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
    const assignEvent = JSON.parse(published[1]!) as typeof sessionEvent & { type: 'kitchen.device.changed' };
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
});
