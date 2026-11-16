import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../apps/api/src/database';
import { digest, hashPassword } from '../../apps/api/src/domain';
import { apiMetrics } from '../../apps/api/src/observability/metrics';
import { attachRealtime } from '../../apps/api/src/realtime';

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

describe('Prometheus /metrics & PostgreSQL/Socket.IO telemetry (M2-T02)', () => {
  const tenantId = randomUUID();
  const storeId = randomUUID();
  const userId = randomUUID();
  const stationId = randomUUID();
  const ingredientId = randomUUID();
  const productId = randomUUID();
  const sessionToken = randomBytes(32).toString('hex');

  let app: ConfiguredHttpApp;
  let closeRealtime: (() => Promise<void>) | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    apiMetrics.registry.resetMetrics();

    await db.tenant.create({ data: { id: tenantId, name: 'Metrics Tenant' } });
    await db.store.create({ data: { id: storeId, tenantId, name: 'Metrics Store' } });
    await db.user.create({
      data: {
        id: userId,
        email: `metrics-${tenantId}@omnihub.test`,
        passwordHash: hashPassword('MetricsPass123!'),
        active: true,
      },
    });
    await db.membership.create({ data: { tenantId, storeId, userId, role: 'OWNER' } });
    await db.session.create({
      data: {
        tokenHash: digest(sessionToken),
        tenantId,
        storeId,
        userId,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await db.station.create({ data: { id: stationId, tenantId, storeId, name: 'Bar', active: true } });
    await db.ingredient.create({ data: { id: ingredientId, tenantId, storeId, name: 'Espresso Beans', unit: 'g' } });
    await db.balance.create({ data: { tenantId, storeId, ingredientId, onHand: 100, reserved: 0 } });
    await db.product.create({
      data: { id: productId, tenantId, storeId, stationId, name: 'Espresso', price: 35000, active: true, manualAvailable: true },
    });
    await db.recipeItem.create({ data: { tenantId, storeId, productId, ingredientId, quantity: 10 } });

    const httpAppModuleId = ['..', '..', 'apps', 'api', 'src', 'http-app'].join('/');
    const { createConfiguredHttpApp } = (await import(httpAppModuleId)) as {
      createConfiguredHttpApp: (options?: { origin?: string; enableAccessLogs?: boolean }) => Promise<ConfiguredHttpApp>;
    };
    app = await createConfiguredHttpApp({ origin: TEST_ORIGIN, enableAccessLogs: false });
    await app.listen(0, '127.0.0.1');
    closeRealtime = attachRealtime(app.getHttpServer(), TEST_ORIGIN);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (closeRealtime) await closeRealtime();
    if (app) await app.close();
    await db.outbox.deleteMany({ where: { tenantId } });
    await db.session.deleteMany({ where: { tenantId } });
    await db.$disconnect();
  });

  it('serves Prometheus metrics on loopback, blocks proxied/unauthorized requests, and updates real HTTP, CommandBus, Outbox lag, and Socket.IO telemetry', async () => {
    // 1. Caddyfile blocks public proxy /metrics requests at the TLS edge
    const caddyfile = readFileSync(resolve('deploy/Caddyfile'), 'utf8');
    expect(caddyfile).toContain('respond /metrics* 403');

    // 2. Proxied requests carrying X-Forwarded-For are denied 403 fail-closed (before backlog cache populates)
    const proxied = await httpRequest(baseUrl, 'GET', '/metrics', { 'X-Forwarded-For': '203.0.113.5' });
    expect(proxied.status).toBe(403);
    expect(JSON.parse(proxied.body)).toMatchObject({ code: 'METRICS_ACCESS_DENIED' });

    // 3. Execute real HTTP calls + Serializable CommandBus transaction creating real Outbox row
    const healthRes = await httpRequest(baseUrl, 'GET', '/health');
    expect(healthRes.status).toBe(200);

    const notFoundRes = await httpRequest(baseUrl, 'GET', '/nonexistent-probe-xyz');
    expect(notFoundRes.status).toBe(404);

    const orderRes = await httpRequest(
      baseUrl,
      'POST',
      '/orders',
      {
        Origin: TEST_ORIGIN,
        Cookie: `session=${sessionToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      JSON.stringify({ lines: [{ productId, quantity: 1 }] }),
    );
    expect(orderRes.status).toBe(201);

    // 4. Connect real authenticated Socket.IO client over HTTP polling, verify active socket metric, then disconnect
    const open = await httpRequest(baseUrl, 'GET', '/socket.io/?EIO=4&transport=polling', {
      Origin: TEST_ORIGIN,
      Cookie: `session=${sessionToken}`,
    });
    expect(open.status).toBe(200);
    const sid = (JSON.parse(open.body.slice(1)) as { sid: string }).sid;
    await httpRequest(
      baseUrl,
      'POST',
      `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
      { Origin: TEST_ORIGIN, Cookie: `session=${sessionToken}` },
      '40',
    );
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));

    const duringSocketScrape = await httpRequest(baseUrl, 'GET', '/metrics');
    expect(duringSocketScrape.status).toBe(200);
    expect(duringSocketScrape.headers['content-type']).toContain('text/plain');
    expect(duringSocketScrape.headers['content-type']).toContain('0.0.4');
    expect(duringSocketScrape.body).toContain('realtime_connected_sockets{service="omnihub-api"} 1');
    expect(duringSocketScrape.body).toContain('realtime_connections_total{outcome="accepted",service="omnihub-api"} 1');

    // Close Socket.IO connection cleanly and verify gauge decrements
    await httpRequest(
      baseUrl,
      'POST',
      `/socket.io/?EIO=4&transport=polling&sid=${sid}`,
      { Origin: TEST_ORIGIN, Cookie: `session=${sessionToken}` },
      '41',
    );
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));

    // 5. Token protection mode denies missing/invalid token even on loopback, allows exact Bearer token
    process.env.METRICS_AUTH_TOKEN = 'integration-scrape-token-secret-123';
    try {
      const noAuth = await httpRequest(baseUrl, 'GET', '/metrics');
      expect(noAuth.status).toBe(403);
      const withAuth = await httpRequest(baseUrl, 'GET', '/metrics', {
        Authorization: 'Bearer integration-scrape-token-secret-123',
      });
      expect(withAuth.status).toBe(200);
      expect(withAuth.body).toContain('http_requests_total{method="GET",route="/health",status_class="2xx",service="omnihub-api"} 1');
      expect(withAuth.body).toContain('http_requests_total{method="GET",route="unmatched",status_class="4xx",service="omnihub-api"} 1');
      expect(withAuth.body).toContain('http_requests_total{method="POST",route="/orders",status_class="2xx",service="omnihub-api"} 1');
      expect(withAuth.body).toContain('command_bus_attempts_total{operation="order.accepted",outcome="success",service="omnihub-api"} 1');
      expect(withAuth.body).toContain('realtime_connected_sockets{service="omnihub-api"} 0');
      expect(withAuth.body).toContain('realtime_disconnects_total{reason="client_disconnect",service="omnihub-api"} 1');
      expect(withAuth.body).toMatch(/outbox_pending_count\{service="omnihub-api"\} [1-9]\d*/);
      expect(withAuth.body).not.toContain(tenantId);
      expect(withAuth.body).not.toContain(storeId);
      expect(withAuth.body).not.toContain(userId);
      expect(withAuth.body).not.toContain(sessionToken);
    } finally {
      delete process.env.METRICS_AUTH_TOKEN;
    }
  });
});
