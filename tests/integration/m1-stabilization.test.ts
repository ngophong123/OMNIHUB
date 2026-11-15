import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../apps/api/src/database';
import { digest, hashPassword } from '../../apps/api/src/domain';
import { processOutboxBatch } from '../../apps/api/src/outbox';
import { PilotAdmin } from '../../apps/api/src/pilot-admin';
import { QrOrdering } from '../../apps/api/src/qr-ordering';
import {
  attachRealtime,
  broadcastOperationalEvent,
  revalidateRealtimeSockets,
  type RealtimeServerLike,
  type RealtimeSocketLike,
} from '../../apps/api/src/realtime';

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
  return new Promise((resolve, reject) => {
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
          resolve({
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

function parseSessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of list) {
    const match = cookie.match(/session=([^;]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('MISSING_SESSION_COOKIE');
}

describe('M1 backend stabilization on real PostgreSQL', () => {
  const TEST_ORIGIN = 'http://localhost:3000';
  const tenantA = randomUUID();
  const storeA = randomUUID();
  const tenantB = randomUUID();
  const storeB = randomUUID();

  const ownerEmail = `m1-owner-${tenantA.slice(0, 8)}@omnihub.local`;
  const cashierEmail = `m1-cashier-${tenantA.slice(0, 8)}@omnihub.local`;
  const kitchen1Email = `m1-kitchen1-${tenantA.slice(0, 8)}@omnihub.local`;
  const kitchen2Email = `m1-kitchen2-${tenantA.slice(0, 8)}@omnihub.local`;
  const tenantBEmail = `m1-other-${tenantB.slice(0, 8)}@omnihub.local`;
  const password = 'M1StrongPassword#2026';

  let ownerUserId = '';
  let cashierUserId = '';
  let kitchen1UserId = '';
  let kitchen2UserId = '';
  let tenantBUserId = '';

  const stationActive = randomUUID();
  const stationSecondary = randomUUID();
  const stationInactive = randomUUID();
  const stationArchived = randomUUID();
  const catActive = randomUUID();
  const catInactive = randomUUID();
  const prodVisible = randomUUID();
  const prodInactiveStation = randomUUID();
  const prodArchivedStation = randomUUID();
  const prodInactiveCategory = randomUUID();

  const tableId = randomUUID();
  const qrToken = randomBytes(32).toString('hex');
  const trackingToken = randomBytes(32).toString('hex');
  const trackedOrderId = randomUUID();

type ConfiguredHttpApp = {
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): http.Server;
  close(): Promise<void>;
};

let app: ConfiguredHttpApp;
  let apiBaseUrl = '';
  let closeRealtime: (() => Promise<void>) | undefined;
  let realtimeBaseUrl = '';
  let realtimeServer: http.Server | undefined;

  let workerDb1: PrismaClient;
  let workerDb2: PrismaClient;
  let queryCountDb: PrismaClient;
  let queryCount = 0;

  beforeAll(async () => {
    const pwHash = hashPassword(password);

    await db.tenant.create({ data: { id: tenantA, name: 'M1 Tenant A' } });
    await db.store.create({ data: { id: storeA, tenantId: tenantA, name: 'M1 Store A', qrOrderingEnabled: true } });
    await db.tenant.create({ data: { id: tenantB, name: 'M1 Tenant B' } });
    await db.store.create({ data: { id: storeB, tenantId: tenantB, name: 'M1 Store B', qrOrderingEnabled: false } });

    const owner = await db.user.create({ data: { email: ownerEmail, passwordHash: pwHash } });
    const cashier = await db.user.create({ data: { email: cashierEmail, passwordHash: pwHash } });
    const kitchen1 = await db.user.create({ data: { email: kitchen1Email, passwordHash: pwHash } });
    const kitchen2 = await db.user.create({ data: { email: kitchen2Email, passwordHash: pwHash } });
    const otherUser = await db.user.create({ data: { email: tenantBEmail, passwordHash: pwHash } });

    ownerUserId = owner.id;
    cashierUserId = cashier.id;
    kitchen1UserId = kitchen1.id;
    kitchen2UserId = kitchen2.id;
    tenantBUserId = otherUser.id;

    await db.membership.createMany({
      data: [
        { tenantId: tenantA, storeId: storeA, userId: ownerUserId, role: 'OWNER' },
        { tenantId: tenantA, storeId: storeA, userId: cashierUserId, role: 'CASHIER' },
        { tenantId: tenantA, storeId: storeA, userId: kitchen1UserId, role: 'KITCHEN' },
        { tenantId: tenantA, storeId: storeA, userId: kitchen2UserId, role: 'KITCHEN' },
        { tenantId: tenantB, storeId: storeB, userId: tenantBUserId, role: 'OWNER' },
      ],
    });

    await db.station.createMany({
      data: [
        { id: stationActive, tenantId: tenantA, storeId: storeA, name: 'Active Grill', active: true },
        { id: stationSecondary, tenantId: tenantA, storeId: storeA, name: 'Active Bar', active: true },
        { id: stationInactive, tenantId: tenantA, storeId: storeA, name: 'Disabled Station', active: false },
        { id: stationArchived, tenantId: tenantA, storeId: storeA, name: 'Archived Station', active: true, deletedAt: new Date() },
      ],
    });

    await db.category.createMany({
      data: [
        { id: catActive, tenantId: tenantA, storeId: storeA, name: 'Mains', active: true },
        { id: catInactive, tenantId: tenantA, storeId: storeA, name: 'Retired Category', active: false },
      ],
    });

    await db.product.createMany({
      data: [
        {
          id: prodVisible,
          tenantId: tenantA,
          storeId: storeA,
          stationId: stationActive,
          categoryId: catActive,
          name: 'M1 Visible Dish',
          price: 50000,
          active: true,
        },
        {
          id: prodInactiveStation,
          tenantId: tenantA,
          storeId: storeA,
          stationId: stationInactive,
          categoryId: catActive,
          name: 'M1 Inactive Station Dish',
          price: 45000,
          active: true,
        },
        {
          id: prodArchivedStation,
          tenantId: tenantA,
          storeId: storeA,
          stationId: stationArchived,
          categoryId: catActive,
          name: 'M1 Archived Station Dish',
          price: 40000,
          active: true,
        },
        {
          id: prodInactiveCategory,
          tenantId: tenantA,
          storeId: storeA,
          stationId: stationActive,
          categoryId: catInactive,
          name: 'M1 Inactive Category Dish',
          price: 35000,
          active: true,
        },
      ],
    });

    await db.restaurantTable.create({
      data: {
        id: tableId,
        tenantId: tenantA,
        storeId: storeA,
        name: 'Table M1-01',
        qrTokenHash: digest(qrToken),
        active: true,
        qrEnabled: true,
        updatedAt: new Date(),
      },
    });

    const ticketId = randomUUID();
    await db.order.create({
      data: {
        id: trackedOrderId,
        tenantId: tenantA,
        storeId: storeA,
        total: 50000,
        trackingTokenHash: digest(trackingToken),
      },
    });
    await db.kitchenTicket.create({
      data: {
        id: ticketId,
        tenantId: tenantA,
        storeId: storeA,
        orderId: trackedOrderId,
        stationId: stationActive,
      },
    });
    await db.orderItem.create({
      data: {
        tenantId: tenantA,
        storeId: storeA,
        orderId: trackedOrderId,
        ticketId,
        productId: prodVisible,
        name: 'M1 Visible Dish',
        unitPrice: 50000,
        recipeVersion: 1,
        recipeSnapshot: [],
      },
    });

    const httpAppModuleId = ['..', '..', 'apps', 'api', 'src', 'http-app'].join('/');
    const { createConfiguredHttpApp } = (await import(httpAppModuleId)) as {
      createConfiguredHttpApp: (options?: { origin?: string; enableAccessLogs?: boolean }) => Promise<ConfiguredHttpApp>;
    };
    app = await createConfiguredHttpApp({ origin: TEST_ORIGIN, enableAccessLogs: false });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    apiBaseUrl = `http://127.0.0.1:${addr.port}`;

    realtimeServer = http.createServer();
    await new Promise<void>(resolve => realtimeServer!.listen(0, '127.0.0.1', resolve));
    const rtAddr = realtimeServer.address() as { port: number };
    realtimeBaseUrl = `http://127.0.0.1:${rtAddr.port}`;
    closeRealtime = attachRealtime(realtimeServer, TEST_ORIGIN);

    workerDb1 = new PrismaClient();
    workerDb2 = new PrismaClient();
    queryCountDb = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    (queryCountDb as unknown as { $on(event: 'query', cb: () => void): void }).$on('query', () => {
      queryCount++;
    });
  });

  afterAll(async () => {
    if (closeRealtime) await closeRealtime();
    if (realtimeServer) await new Promise<void>(resolve => realtimeServer!.close(() => resolve()));
    if (app) await app.close();

    await workerDb1?.$disconnect();
    await workerDb2?.$disconnect();
    await queryCountDb?.$disconnect();

    const tenants = [tenantA, tenantB];
    await db.outbox.deleteMany({ where: { tenantId: { in: tenants } } });
    await db.session.deleteMany({ where: { tenantId: { in: tenants } } });
    await db.kitchenDevice.updateMany({ where: { tenantId: { in: tenants }, revokedAt: null }, data: { revokedAt: new Date() } });
    await db.$disconnect();
  });

  it('prevents duplicate outbox claims across concurrent workers using FOR UPDATE SKIP LOCKED', async () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await db.outbox.createMany({
      data: ids.map((id, idx) => ({
        id,
        tenantId: tenantA,
        storeId: storeA,
        type: 'order.accepted',
        aggregateId: trackedOrderId,
        version: 1,
        correlationId: `conc-${idx}`,
        createdAt: new Date(`2000-01-01T00:00:00.${String(idx + 1).padStart(3, '0')}Z`),
      })),
    });

    const published1: string[] = [];
    const published2: string[] = [];
    const slowPublisher = (bucket: string[]) => ({
      publish: async (_channel: string, payload: string) => {
        const event = JSON.parse(payload) as { eventId: string };
        await new Promise(resolve => setTimeout(resolve, 35));
        bucket.push(event.eventId);
        return 1;
      },
    });

    const [res1, res2] = await Promise.all([
      processOutboxBatch({ db: workerDb1, redis: slowPublisher(published1), batchSize: 3, tenantIds: [tenantA] }),
      processOutboxBatch({ db: workerDb2, redis: slowPublisher(published2), batchSize: 3, tenantIds: [tenantA] }),
    ]);

    expect(res1).toMatchObject({ claimed: 3, delivered: 3, quarantined: 0 });
    expect(res2).toMatchObject({ claimed: 3, delivered: 3, quarantined: 0 });
    expect(new Set([...published1, ...published2])).toEqual(new Set(ids));

    const pendingCount = await db.outbox.count({ where: { id: { in: ids }, deliveredAt: null } });
    expect(pendingCount).toBe(0);
  });

  it('commits partial outbox deliveries before transient publish failures and isolates invalid events', async () => {
    const partialIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.outbox.createMany({
      data: partialIds.map((id, idx) => ({
        id,
        tenantId: tenantA,
        storeId: storeA,
        type: 'order.accepted',
        aggregateId: trackedOrderId,
        version: 1,
        correlationId: `partial-${idx}`,
        createdAt: new Date(`2000-01-01T00:01:00.${String(idx + 1).padStart(3, '0')}Z`),
      })),
    });

    let attempt = 0;
    const partialResult = await processOutboxBatch({
      db: workerDb1,
      batchSize: 3,
      tenantIds: [tenantA],
      redis: {
        publish: async () => {
          attempt++;
          if (attempt === 2) throw new Error('REDIS_TRANSIENT_FAILURE');
          return 1;
        },
      },
    });

    expect(partialResult.claimed).toBe(3);
    expect(partialResult.delivered).toBe(1);
    expect(partialResult.error?.message).toBe('REDIS_TRANSIENT_FAILURE');

    const rowsAfterPartial = await db.outbox.findMany({
      where: { id: { in: partialIds } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rowsAfterPartial[0]?.deliveredAt).not.toBeNull();
    expect(rowsAfterPartial[1]?.deliveredAt).toBeNull();
    expect(rowsAfterPartial[2]?.deliveredAt).toBeNull();

    const retryResult = await processOutboxBatch({
      db: workerDb1,
      batchSize: 3,
      tenantIds: [tenantA],
      redis: { publish: async () => 1 },
    });
    expect(retryResult).toMatchObject({ claimed: 2, delivered: 2, quarantined: 0 });

    const invalidId = randomUUID();
    const validAfterInvalidId = randomUUID();
    await db.outbox.createMany({
      data: [
        {
          id: invalidId,
          tenantId: tenantA,
          storeId: storeA,
          type: 'invalid.schema.event',
          aggregateId: trackedOrderId,
          version: 1,
          correlationId: 'poison-1',
          createdAt: new Date('2000-01-01T00:02:00.001Z'),
        },
        {
          id: validAfterInvalidId,
          tenantId: tenantA,
          storeId: storeA,
          type: 'kitchen.item.ready',
          aggregateId: trackedOrderId,
          version: 1,
          correlationId: 'poison-ok-2',
          createdAt: new Date('2000-01-01T00:02:00.002Z'),
        },
      ],
    });

    const quarantinedIds = new Set<string>();
    const quarantineResult = await processOutboxBatch({
      db: workerDb1,
      batchSize: 2,
      quarantinedIds,
      tenantIds: [tenantA],
      redis: { publish: async () => 1 },
    });

    expect(quarantineResult).toMatchObject({ claimed: 2, delivered: 1, quarantined: 1 });
    expect(quarantinedIds.has(invalidId)).toBe(true);
    expect((await db.outbox.findUnique({ where: { id: invalidId } }))?.deliveredAt).toBeNull();
    expect((await db.outbox.findUnique({ where: { id: validAfterInvalidId } }))?.deliveredAt).not.toBeNull();

    const cleanFollowUp = await processOutboxBatch({
      db: workerDb1,
      batchSize: 2,
      quarantinedIds,
      tenantIds: [tenantA],
      redis: { publish: async () => 1 },
    });
    expect(cleanFollowUp).toMatchObject({ claimed: 0, delivered: 0, quarantined: 0 });

    await db.outbox.deleteMany({ where: { id: { in: [invalidId] } } });
  });

  it('commits delivered outbox rows before Prisma transaction expiration under sustained slow Redis responses and drains remaining rows', async () => {
    const slowIds = Array.from({ length: 5 }, () => randomUUID());
    await db.outbox.createMany({
      data: slowIds.map((id, idx) => ({
        id,
        tenantId: tenantA,
        storeId: storeA,
        type: 'order.accepted',
        aggregateId: trackedOrderId,
        version: 1,
        correlationId: `budget-${idx}`,
        createdAt: new Date(`2000-01-01T00:03:00.${String(idx + 1).padStart(3, '0')}Z`),
      })),
    });

    let attempt = 0;
    const firstBatch = await processOutboxBatch({
      db: workerDb1,
      batchSize: 5,
      tenantIds: [tenantA],
      publishTimeoutMs: 5_000,
      batchTimeBudgetMs: 250,
      transactionTimeoutMs: 3_000,
      redis: {
        publish: async () => {
          attempt++;
          // First event finishes cleanly; subsequent slow response (< 5s per-event timeout) hits batch budget well before tx timeout.
          const delayMs = attempt === 1 ? 15 : 350;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return 1;
        },
      },
    });

    expect(firstBatch.claimed).toBe(5);
    expect(firstBatch.delivered).toBe(1);
    expect(firstBatch.quarantined).toBe(0);
    expect(firstBatch.budgetExceeded).toBe(true);
    expect(firstBatch.error).toBeUndefined();

    const rowsAfterFirst = await db.outbox.findMany({
      where: { id: { in: slowIds } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rowsAfterFirst[0]?.deliveredAt).not.toBeNull();
    expect(rowsAfterFirst.slice(1).every(row => row.deliveredAt === null)).toBe(true);

    // Concurrent workers drain the remaining pending rows via FOR UPDATE SKIP LOCKED without duplicating the committed row.
    const worker1Ids: string[] = [];
    const worker2Ids: string[] = [];
    const collectPublisher = (target: string[]) => ({
      publish: async (_channel: string, payload: string) => {
        const event = JSON.parse(payload) as { eventId: string };
        await new Promise(resolve => setTimeout(resolve, 25));
        target.push(event.eventId);
        return 1;
      },
    });

    const [drain1, drain2] = await Promise.all([
      processOutboxBatch({ db: workerDb1, batchSize: 2, tenantIds: [tenantA], redis: collectPublisher(worker1Ids) }),
      processOutboxBatch({ db: workerDb2, batchSize: 2, tenantIds: [tenantA], redis: collectPublisher(worker2Ids) }),
    ]);

    expect(drain1).toMatchObject({ claimed: 2, delivered: 2, quarantined: 0 });
    expect(drain2).toMatchObject({ claimed: 2, delivered: 2, quarantined: 0 });
    expect(new Set([...worker1Ids, ...worker2Ids])).toEqual(new Set(slowIds.slice(1)));
    expect(await db.outbox.count({ where: { id: { in: slowIds }, deliveredAt: null } })).toBe(0);
  });

  it('enforces HTTP security headers, CSRF origin check, sanitized error envelopes, RBAC, QR hardening, and active-station filtering', async () => {
    const evilOriginRes = await httpRequest(apiBaseUrl, 'GET', '/health', { Origin: 'http://evil.example' });
    expect(evilOriginRes.status).toBe(403);
    expect(JSON.parse(evilOriginRes.body)).toMatchObject({ code: 'ORIGIN_DENIED' });

    const missingOriginMutation = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { 'Content-Type': 'application/json' },
      JSON.stringify({ email: ownerEmail, password }),
    );
    expect(missingOriginMutation.status).toBe(403);
    expect(JSON.parse(missingOriginMutation.body)).toMatchObject({ code: 'ORIGIN_DENIED' });

    const healthRes = await httpRequest(apiBaseUrl, 'GET', '/health', { Origin: TEST_ORIGIN });
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers['x-content-type-options']).toBe('nosniff');
    expect(healthRes.headers['referrer-policy']).toBe('no-referrer');
    expect(healthRes.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(healthRes.headers['cache-control']).toBe('no-store');
    expect(healthRes.headers['x-frame-options']).toBe('DENY');
    expect(healthRes.headers['content-security-policy']).toContain("default-src 'none'");
    expect(healthRes.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const notFoundRes = await httpRequest(apiBaseUrl, 'GET', '/unknown/path?secret=123', { Origin: TEST_ORIGIN });
    expect(notFoundRes.status).toBe(404);
    expect(JSON.parse(notFoundRes.body)).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    expect(notFoundRes.body).not.toContain('/unknown/path');

    const invalidJsonRes = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      '{"broken":',
    );
    expect(invalidJsonRes.status).toBe(400);
    const invalidJsonPayload = JSON.parse(invalidJsonRes.body) as { code: string };
    expect(['BAD_REQUEST', 'INVALID_JSON_BODY']).toContain(invalidJsonPayload.code);
    expect(invalidJsonRes.body).not.toContain('Unexpected');

    const ownerLogin = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      JSON.stringify({ email: ownerEmail, password, storeId: storeA }),
    );
    expect(ownerLogin.status).toBe(201);
    const ownerCookie = parseSessionCookie(ownerLogin.headers['set-cookie']);

    const cashierLogin = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      JSON.stringify({ email: cashierEmail, password, storeId: storeA }),
    );
    expect(cashierLogin.status).toBe(201);
    const cashierCookie = parseSessionCookie(cashierLogin.headers['set-cookie']);

    const tenantBLogin = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      JSON.stringify({ email: tenantBEmail, password, storeId: storeB }),
    );
    expect(tenantBLogin.status).toBe(201);
    const tenantBCookie = parseSessionCookie(tenantBLogin.headers['set-cookie']);

    const cashierForbidden = await httpRequest(apiBaseUrl, 'GET', '/admin/invitations', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${cashierCookie}`,
    });
    expect(cashierForbidden.status).toBe(403);
    expect(JSON.parse(cashierForbidden.body)).toMatchObject({ code: 'PERMISSION_DENIED' });

    const invalidQrRes = await httpRequest(apiBaseUrl, 'GET', '/admin/tables/qr-code?token=short', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
    });
    expect(invalidQrRes.status).toBe(400);
    expect(JSON.parse(invalidQrRes.body)).toMatchObject({ code: 'QR_TOKEN_INVALID' });

    const missingQrRes = await httpRequest(apiBaseUrl, 'GET', `/admin/tables/qr-code?token=${'f'.repeat(64)}`, {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
    });
    expect(missingQrRes.status).toBe(404);
    expect(JSON.parse(missingQrRes.body)).toMatchObject({ code: 'TABLE_NOT_FOUND' });

    const headerQrRes = await httpRequest(apiBaseUrl, 'GET', '/admin/tables/qr-code', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
      'X-QR-Token': qrToken,
    });
    expect(headerQrRes.status).toBe(200);
    expect(headerQrRes.headers['content-type']).toContain('image/svg+xml');
    expect(headerQrRes.headers['cache-control']).toBe('no-store');
    expect(headerQrRes.headers['referrer-policy']).toBe('no-referrer');
    expect(headerQrRes.headers['x-content-type-options']).toBe('nosniff');
    expect(headerQrRes.body).toContain('<svg');

    const tenantBQrRes = await httpRequest(apiBaseUrl, 'GET', '/admin/tables/qr-code', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${tenantBCookie}`,
      'X-QR-Token': qrToken,
    });
    expect(tenantBQrRes.status).toBe(404);

    // Track E: both authenticated catalog and customer public menu exclude inactive/archived station products.
    const catalogRes = await httpRequest(apiBaseUrl, 'GET', '/catalog', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
    });
    expect(catalogRes.status).toBe(200);
    const catalogProducts = JSON.parse(catalogRes.body) as { id: string }[];
    expect(catalogProducts.map(p => p.id)).toEqual([prodVisible]);

    const menuResult = await new QrOrdering(db).publicMenu(qrToken);
    expect(menuResult.products.map(p => p.id)).toEqual([prodVisible]);

    const readinessRes = await httpRequest(apiBaseUrl, 'GET', '/admin/pilot-readiness', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
    });
    expect(readinessRes.status).toBe(200);
    const readiness = JSON.parse(readinessRes.body) as { checks: { activeProducts: number } };
    expect(readiness.checks.activeProducts).toBe(1);

    // Track E: kitchen device ownership prevents cross-user takeover and lists only tenant-scoped sessions.
    const kitchen1Login = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      JSON.stringify({ email: kitchen1Email, password, storeId: storeA }),
    );
    const kitchen2Login = await httpRequest(
      apiBaseUrl,
      'POST',
      '/auth/login',
      { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
      JSON.stringify({ email: kitchen2Email, password, storeId: storeA }),
    );
    const kitchen1Cookie = parseSessionCookie(kitchen1Login.headers['set-cookie']);
    const kitchen2Cookie = parseSessionCookie(kitchen2Login.headers['set-cookie']);
    const deviceId = randomUUID();

    const reg1 = await httpRequest(
      apiBaseUrl,
      'POST',
      '/kitchen/devices/register',
      { Origin: TEST_ORIGIN, Cookie: `session=${kitchen1Cookie}`, 'Content-Type': 'application/json' },
      JSON.stringify({ deviceId }),
    );
    expect(reg1.status).toBe(201);

    const regHijack = await httpRequest(
      apiBaseUrl,
      'POST',
      '/kitchen/devices/register',
      { Origin: TEST_ORIGIN, Cookie: `session=${kitchen2Cookie}`, 'Content-Type': 'application/json' },
      JSON.stringify({ deviceId }),
    );
    expect(regHijack.status).toBe(403);
    expect(JSON.parse(regHijack.body)).toMatchObject({ code: 'KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE' });

    // Track D: logout clears session cookie with HttpOnly + SameSite=Strict and invalidates session inside admin TX.
    const logoutRes = await httpRequest(apiBaseUrl, 'POST', '/auth/logout', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${ownerCookie}`,
    });
    expect(logoutRes.status).toBe(201);
    const logoutSetCookie = String(logoutRes.headers['set-cookie'] ?? '');
    expect(logoutSetCookie).toContain('session=;');
    expect(logoutSetCookie).toContain('HttpOnly');
    expect(logoutSetCookie).toContain('SameSite=Strict');

    const pilotAdmin = new PilotAdmin(db);
    await expect(
      pilotAdmin.createInvitation(
        {
          tenantId: tenantA,
          storeId: storeA,
          userId: ownerUserId,
          role: 'OWNER',
          tokenHash: digest(ownerCookie),
          expiresAt: new Date(Date.now() + 60_000),
          correlationId: 'revoked-tx',
        },
        { email: 'invitee@omnihub.local', role: 'CASHIER' },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('enforces Socket.IO Origin/auth handshake rules and executes O(1) batched PostgreSQL broadcasts', async () => {
    const deniedOrigin = await httpRequest(realtimeBaseUrl, 'GET', '/socket.io/?EIO=4&transport=polling', {
      Origin: 'http://evil.example',
    });
    expect(deniedOrigin.status).toBe(403);

    const pollConnect = async (connectPacket: string, cookie?: string) => {
      const open = await httpRequest(realtimeBaseUrl, 'GET', '/socket.io/?EIO=4&transport=polling', {
        Origin: TEST_ORIGIN,
        ...(cookie ? { Cookie: `session=${cookie}` } : {}),
      });
      expect(open.status).toBe(200);
      const handshake = JSON.parse(open.body.slice(1)) as { sid: string };
      const post = await httpRequest(
        realtimeBaseUrl,
        'POST',
        `/socket.io/?EIO=4&transport=polling&sid=${handshake.sid}`,
        {
          Origin: TEST_ORIGIN,
          ...(cookie ? { Cookie: `session=${cookie}` } : {}),
        },
        connectPacket,
      );
      expect(post.status).toBe(200);
      const poll = await httpRequest(
        realtimeBaseUrl,
        'GET',
        `/socket.io/?EIO=4&transport=polling&sid=${handshake.sid}`,
        {
          Origin: TEST_ORIGIN,
          ...(cookie ? { Cookie: `session=${cookie}` } : {}),
        },
      );
      return poll.body;
    };

    const unauthReply = await pollConnect('40');
    expect(unauthReply).toContain('44');
    expect(unauthReply).toContain('UNAUTHORIZED');

    const ownerToken = randomBytes(32).toString('hex');
    const kitchenToken = randomBytes(32).toString('hex');
    const tenantBToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const deviceOnActiveStation = randomUUID();
    const deviceOnSecondaryStation = randomUUID();

    await db.session.createMany({
      data: [
        { tokenHash: digest(ownerToken), tenantId: tenantA, storeId: storeA, userId: ownerUserId, expiresAt },
        { tokenHash: digest(kitchenToken), tenantId: tenantA, storeId: storeA, userId: kitchen1UserId, expiresAt },
        { tokenHash: digest(tenantBToken), tenantId: tenantB, storeId: storeB, userId: tenantBUserId, expiresAt },
      ],
    });
    await db.kitchenDevice.createMany({
      data: [
        {
          id: deviceOnActiveStation,
          tenantId: tenantA,
          storeId: storeA,
          userId: kitchen1UserId,
          stationId: stationActive,
        },
        {
          id: deviceOnSecondaryStation,
          tenantId: tenantA,
          storeId: storeA,
          userId: kitchen1UserId,
          stationId: stationSecondary,
        },
      ],
    });

    const ownerConnected = await pollConnect('40', ownerToken);
    expect(ownerConnected).toMatch(/^40\{/);

    const kitchenMissingDevice = await pollConnect('40', kitchenToken);
    expect(kitchenMissingDevice).toContain('UNAUTHORIZED');

    const badTracking = await pollConnect(`40${JSON.stringify({ trackingToken: 'short' })}`);
    expect(badTracking).toContain('UNAUTHORIZED');

    const validTracking = await pollConnect(`40${JSON.stringify({ trackingToken })}`);
    expect(validTracking).toMatch(/^40\{/);

    // Verify constant batched query count (no N+1) and device/room isolation on real PG.
    const makeFakeSocket = (data: Record<string, unknown>, id: string): RealtimeSocketLike & {
      events: unknown[];
      disconnected: boolean;
    } => {
      const sock = {
        id,
        data,
        events: [] as unknown[],
        disconnected: false,
        emit: (event: string, ...args: unknown[]) => sock.events.push({ event, args }),
        disconnect: () => {
          sock.disconnected = true;
        },
      };
      return sock;
    };

    const ownerSockets = Array.from({ length: 8 }, (_, idx) =>
      makeFakeSocket({ token: ownerToken, room: `${tenantA}:${storeA}` }, `owner-${idx}`),
    );
    const activeKitchenSock = makeFakeSocket(
      { token: kitchenToken, room: `${tenantA}:${storeA}`, deviceId: deviceOnActiveStation, stationId: stationActive },
      'kitchen-active',
    );
    const secondaryKitchenSock = makeFakeSocket(
      { token: kitchenToken, room: `${tenantA}:${storeA}`, deviceId: deviceOnSecondaryStation, stationId: stationSecondary },
      'kitchen-secondary',
    );
    const crossTenantSock = makeFakeSocket(
      { token: tenantBToken, room: `${tenantB}:${storeB}` },
      'cross-tenant',
    );

    const customerEmits: string[] = [];
    const io: RealtimeServerLike = {
      to: room => ({
        emit: event => customerEmits.push(`${room}:${event}`),
      }),
      in: () => ({
        fetchSockets: async () => [...ownerSockets, activeKitchenSock, secondaryKitchenSock, crossTenantSock],
      }),
    };

    queryCount = 0;
    await broadcastOperationalEvent(io, queryCountDb, {
      eventId: randomUUID(),
      schemaVersion: 1,
      tenantId: tenantA,
      storeId: storeA,
      type: 'order.accepted',
      aggregateId: trackedOrderId,
      version: 1,
      occurredAt: new Date().toISOString(),
    });

    expect(queryCount).toBeLessThanOrEqual(4);
    expect(customerEmits).toEqual([`${tenantA}:${storeA}:order:${trackedOrderId}:customer.order.updated`]);
    expect(ownerSockets.every(s => s.events.length === 1 && !s.disconnected)).toBe(true);
    expect(activeKitchenSock.events.length).toBe(1);
    expect(secondaryKitchenSock.events.length).toBe(0);
    expect(crossTenantSock.disconnected).toBe(true);
    expect(crossTenantSock.events.length).toBe(0);

    // Revoke kitchen device in DB and ensure periodic revalidation disconnects only the revoked device.
    await db.kitchenDevice.update({
      where: { id: deviceOnActiveStation },
      data: { revokedAt: new Date() },
    });

    await revalidateRealtimeSockets([ownerSockets[0]!, activeKitchenSock, secondaryKitchenSock], db);
    expect(ownerSockets[0]!.disconnected).toBe(false);
    expect(secondaryKitchenSock.disconnected).toBe(false);
    expect(activeKitchenSock.disconnected).toBe(true);
  }, 15_000);
});
