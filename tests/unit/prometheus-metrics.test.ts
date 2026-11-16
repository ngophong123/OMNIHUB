import { EventEmitter } from 'node:events';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus } from '../../apps/api/src/commands';
import { Errors } from '../../apps/api/src/errors';
import { createHttpSecurityLoggingMiddleware } from '../../apps/api/src/observability/http-middleware';
import {
  apiMetrics,
  createMetricsRegistry,
  normalizeCommandOperation,
  normalizeErrorCodeLabel,
  normalizeHttpMethod,
  normalizeHttpRouteLabel,
} from '../../apps/api/src/observability/metrics';
import {
  BoundedMemoryRateLimitStore,
  createMetricsRateLimiter,
  createMetricsRequestHandler,
  isLoopbackAddress,
  metricsRateLimitKey,
  resolveMetricsRateLimitConfig,
} from '../../apps/api/src/observability/metrics-endpoint';
import { createOutboxWorkerLoop, processOutboxBatch } from '../../apps/api/src/outbox';
import { createRedisRateLimiter } from '../../apps/api/src/rate-limit';

class TestCommandHarness extends CommandBus {
  async runCommand(ctx: Parameters<CommandBus['command']>[0], key: string, operation: Parameters<CommandBus['command']>[2], payload: unknown, work: Parameters<CommandBus['command']>[4]) {
    return this.command(ctx, key, operation, payload, work, 'pos');
  }
}

describe('prometheus metrics architecture (M2-T02)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiMetrics.registry.resetMetrics();
  });

  it('registers core metrics once cleanly, emits Prometheus exposition format, and handles default metrics idempotently', async () => {
    const m1 = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: true });
    const m2 = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: true });

    expect(m1.contentType).toContain('text/plain');
    expect(m1.contentType).toContain('0.0.4');
    const output = await m1.render();
    expect(output).toContain('# TYPE http_requests_total counter');
    expect(output).toContain('# TYPE http_request_duration_seconds histogram');
    expect(output).toContain('# TYPE rate_limit_decisions_total counter');
    expect(output).toContain('# TYPE command_bus_attempts_total counter');
    expect(output).toContain('# TYPE outbox_pending_count gauge');
    expect(output).toContain('# TYPE realtime_connected_sockets gauge');
    expect(output).toContain('service="omnihub-api"');
    expect(output).toContain('nodejs_');

    m1.close();
    m2.close();
    expect(m1.isClosed()).toBe(true);
    expect(await m1.render()).toBe('');
  });

  it('tracks HTTP request counters, latency histograms, errors, and prevents in-flight gauge leaks on close', async () => {
    const metrics = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });
    const middleware = createHttpSecurityLoggingMiddleware('http://localhost:3000', false, metrics);

    const makeRes = (statusCode = 200) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        setHeader: (k: string, v: string) => void;
        status: (code: number) => typeof res;
        json: (payload: unknown) => typeof res;
      };
      res.statusCode = statusCode;
      res.headers = {};
      res.setHeader = (k: string, v: string) => {
        res.headers[k.toLowerCase()] = v;
      };
      res.status = (code: number) => {
        res.statusCode = code;
        return res;
      };
      res.json = () => res;
      return res;
    };

    // 1. Normal matched request
    const res1 = makeRes(201);
    const req1 = {
      method: 'POST',
      originalUrl: '/orders',
      route: { path: '/orders' },
      get: (h: string) => (h.toLowerCase() === 'origin' ? 'http://localhost:3000' : undefined),
    };
    middleware(req1 as never, res1 as never, () => undefined);
    res1.emit('finish');

    // 2. Origin-denied mutation
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res2 = makeRes(200);
    const req2 = {
      method: 'POST',
      originalUrl: '/orders',
      get: (h: string) => (h.toLowerCase() === 'origin' ? 'https://evil.example' : undefined),
    };
    middleware(req2 as never, res2 as never, () => undefined);
    res2.emit('finish');

    // 3. Aborted request (close without finish) must decrement in-flight back to 0
    const res3 = makeRes(200);
    const req3 = {
      method: 'GET',
      originalUrl: '/health',
      route: { path: '/health' },
      get: () => undefined,
    };
    middleware(req3 as never, res3 as never, () => undefined);
    res3.emit('close');

    // 4. /metrics self-scrapes must not inflate business HTTP request metrics
    const res4 = makeRes(200);
    const req4 = {
      method: 'GET',
      originalUrl: '/metrics',
      get: () => undefined,
    };
    middleware(req4 as never, res4 as never, () => undefined);
    res4.emit('finish');

    const rendered = await metrics.render();
    expect(rendered).toContain('http_requests_total{method="POST",route="/orders",status_class="2xx",service="omnihub-api"} 1');
    expect(rendered).toContain('http_requests_total{method="POST",route="/orders/*",status_class="4xx",service="omnihub-api"} 1');
    expect(rendered).toContain('http_errors_total{method="POST",route="/orders/*",code="ORIGIN_DENIED",service="omnihub-api"} 1');
    expect(rendered).toContain('http_request_duration_seconds_count{service="omnihub-api",method="POST",route="/orders",status_class="2xx"} 1');
    expect(rendered).toContain('http_requests_in_flight{method="GET",service="omnihub-api"} 0');
    expect(rendered).toContain('http_requests_in_flight{method="POST",service="omnihub-api"} 0');
    expect(rendered).not.toContain('route="/metrics"');
    metrics.close();
  });

  it('enforces bounded label cardinality and excludes PII, IPs, emails, tokens, and tenant IDs', async () => {
    const metrics = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });

    // Flood 50 distinct arbitrary fuzz URLs with UUIDs, hex tokens, emails, IPs, and tenant identifiers
    for (let i = 0; i < 50; i++) {
      metrics.recordHttpRequest({
        method: i % 2 === 0 ? 'GET' : 'PROPFIND',
        originalUrl: `/wp-admin/probe-${i}/tenant-${i}/owner@example.com?token=${'a'.repeat(64)}&userId=u-${i}`,
        statusCode: 404,
        durationSeconds: 0.01,
      });
      metrics.recordHttpRequest({
        method: 'GET',
        originalUrl: `/public/qr/${'b'.repeat(64)}/menu?storeId=store-${i}`,
        statusCode: 200,
        durationSeconds: 0.02,
      });
    }
    metrics.recordCommandBusAttempt('unknown.arbitrary.operation', 'success');
    metrics.recordHttpError({ method: 'GET', originalUrl: '/random', code: 'arbitrary_attacker_code_999' });

    const rendered = await metrics.render();
    expect(rendered).not.toContain('probe-');
    expect(rendered).not.toContain('owner@example.com');
    expect(rendered).not.toContain('a'.repeat(16));
    expect(rendered).not.toContain('b'.repeat(16));
    expect(rendered).not.toContain('store-');
    expect(rendered).not.toContain('userId');
    expect(rendered).not.toContain('PROPFIND');
    expect(rendered).not.toContain('unknown.arbitrary.operation');
    expect(rendered).not.toContain('arbitrary_attacker_code_999');

    expect(normalizeHttpMethod('TRACE')).toBe('OTHER');
    expect(normalizeHttpRouteLabel(undefined, '/orders/550e8400-e29b-41d4-a716-446655440000/pay')).toBe('/orders/*');
    expect(normalizeCommandOperation('weird')).toBe('other');
    expect(normalizeErrorCodeLabel('spoofed_error')).toBe('OTHER_ERROR');
    expect(rendered).toContain('http_requests_total{method="GET",route="unmatched",status_class="4xx",service="omnihub-api"} 25');
    expect(rendered).toContain('http_requests_total{method="OTHER",route="unmatched",status_class="4xx",service="omnihub-api"} 25');
    expect(rendered).toContain('http_requests_total{method="GET",route="/public/qr/:credential/menu",status_class="2xx",service="omnihub-api"} 50');
    metrics.close();
  });

  it('records rate limiter allow/429/503 decisions and Errors DB error codes without PII labels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const allowedLimiter = createRedisRateLimiter(
      { eval: vi.fn().mockResolvedValue([1, 60_000]) } as never,
      { prefix: 'public', limit: 10, windowMs: 60_000 },
    );
    const blockedLimiter = createRedisRateLimiter(
      { eval: vi.fn().mockResolvedValue([11, 30_000]) } as never,
      { prefix: 'login', limit: 10, windowMs: 60_000 },
    );
    const downLimiter = createRedisRateLimiter(
      { eval: vi.fn().mockRejectedValue(new Error('redis down')) } as never,
      { prefix: 'login', limit: 10, windowMs: 60_000 },
    );

    const req = { ip: '203.0.113.42', socket: { remoteAddress: '203.0.113.42' } };
    const makeRes = (done: () => void) => ({
      getHeader: vi.fn().mockReturnValue(undefined),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(() => done()),
    });

    await new Promise<void>(resolve => allowedLimiter(req as never, makeRes(() => undefined) as never, () => resolve()));
    await new Promise<void>(resolve => blockedLimiter(req as never, makeRes(resolve) as never, () => undefined));
    await new Promise<void>(resolve => downLimiter(req as never, makeRes(resolve) as never, () => undefined));

    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', originalUrl: '/orders' }),
        getResponse: () => ({
          getHeader: () => 'corr-db-01',
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        }),
      }),
    };
    const poolErr = new Prisma.PrismaClientKnownRequestError('timeout', { code: 'P2024', clientVersion: '6.19.0' });
    new Errors().catch(poolErr, host as never);

    const rendered = await apiMetrics.render();
    expect(rendered).toContain('rate_limit_decisions_total{prefix="public",outcome="allowed",service="omnihub-api"} 1');
    expect(rendered).toContain('rate_limit_decisions_total{prefix="login",outcome="blocked_429",service="omnihub-api"} 1');
    expect(rendered).toContain('rate_limit_decisions_total{prefix="login",outcome="unavailable_503",service="omnihub-api"} 1');
    expect(rendered).toContain('db_errors_total{code="p2024_pool_timeout",service="omnihub-api"} 1');
    expect(rendered).not.toContain('203.0.113.42');
  });

  it('records CommandBus P2034 retry metrics and conflict exhaustion without altering business flow', async () => {
    const txError = new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: '6.19.0' });
    const ctx = {
      tenantId: 't-1',
      storeId: 's-1',
      userId: 'u-1',
      role: 'CASHIER' as const,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      correlationId: 'corr-cmd-01',
    };

    let calls = 0;
    const txStub = {
      session: { findUnique: vi.fn().mockResolvedValue({ userId: 'u-1', tenantId: 't-1', storeId: 's-1', expiresAt: ctx.expiresAt, user: { active: true } }) },
      membership: { findUnique: vi.fn().mockResolvedValue({ tenantId: 't-1', role: 'CASHIER' }) },
      commandReceipt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      audit: { create: vi.fn().mockResolvedValue({}) },
      outbox: { create: vi.fn().mockResolvedValue({}) },
    };

    const retryThenSuccessDb = {
      $transaction: vi.fn(async (fn: (tx: typeof txStub) => Promise<unknown>) => {
        calls++;
        if (calls === 1) throw txError;
        return fn(txStub);
      }),
    };
    const harness = new TestCommandHarness(retryThenSuccessDb as never);
    const key1 = '11111111-1111-4111-8111-111111111111';
    const res = await harness.runCommand(ctx, key1, 'order.accepted', { total: 100 }, async () => ({ id: 'ord-1', version: 1 }));
    expect(res).toEqual({ id: 'ord-1', version: 1 });

    // Exhausted retries -> 409 conflict_exhausted
    const alwaysConflictDb = {
      $transaction: vi.fn().mockRejectedValue(txError),
    };
    const exhaustedHarness = new TestCommandHarness(alwaysConflictDb as never);
    const key2 = '22222222-2222-4222-8222-222222222222';
    await expect(exhaustedHarness.runCommand(ctx, key2, 'order.cancelled', {}, async () => ({ id: 'ord-2', version: 1 }))).rejects.toThrow('CONCURRENT_CHANGE_RETRY_SAME_KEY');

    const rendered = await apiMetrics.render();
    expect(rendered).toContain('command_bus_attempts_total{operation="order.accepted",outcome="retry_p2034",service="omnihub-api"} 1');
    expect(rendered).toContain('command_bus_attempts_total{operation="order.accepted",outcome="success",service="omnihub-api"} 1');
    expect(rendered).toContain('db_transaction_retries_total{operation="order.accepted",reason="p2034_serialization",service="omnihub-api"} 1');
    expect(rendered).toContain('command_bus_attempts_total{operation="order.cancelled",outcome="retry_p2034",service="omnihub-api"} 3');
    expect(rendered).toContain('command_bus_attempts_total{operation="order.cancelled",outcome="conflict_exhausted",service="omnihub-api"} 1');
    expect(rendered).toContain('db_errors_total{code="p2034_serialization",service="omnihub-api"} 5');
  });

  it('tracks outbox published/failed/quarantined metrics, worker health, and cached DB backlog lag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const metrics = createMetricsRegistry({ service: 'omnihub-worker', collectDefaultMetrics: false, outboxBacklogCacheTtlMs: 5_000 });
    const rows = [
      { id: '11111111-1111-4111-8111-111111111111', tenantId: '11111111-1111-4111-8111-111111111112', storeId: '11111111-1111-4111-8111-111111111113', type: 'order.accepted', aggregateId: '11111111-1111-4111-8111-111111111114', version: 1, correlationId: 'corr-1111', createdAt: new Date(Date.now() - 12_000) },
      { id: '22222222-2222-4222-8222-222222222221', tenantId: 'bad-uuid', storeId: 'bad-uuid', type: 'invalid', aggregateId: 'bad', version: 1, correlationId: 'corr-2222', createdAt: new Date() },
    ];
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockDb = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: vi.fn().mockResolvedValue(rows),
          outbox: { updateMany },
        }),
      ),
      outbox: {
        count: vi.fn().mockResolvedValue(4),
        findFirst: vi.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 15_000) }),
      },
    };
    const failingRedis = {
      publish: vi.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue(1),
    };

    const quarantinedIds = new Set<string>();
    const resFail = await processOutboxBatch({
      db: mockDb as never,
      redis: failingRedis,
      quarantinedIds,
      metrics,
    });
    expect(resFail.error).toBeDefined();

    // Concurrent backlog refreshes within TTL coalesce to a single DB query pair
    await Promise.all([
      metrics.refreshOutboxBacklog(mockDb as never),
      metrics.refreshOutboxBacklog(mockDb as never),
      metrics.refreshOutboxBacklog(mockDb as never),
    ]);
    expect(mockDb.outbox.count).toHaveBeenCalledTimes(1);

    // Worker loop transitions degraded -> healthy
    let failStep = true;
    const loopDb = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        if (failStep) {
          failStep = false;
          throw new Error('transient db');
        }
        return fn({ $queryRaw: vi.fn().mockResolvedValue([]), outbox: { updateMany } });
      }),
      outbox: mockDb.outbox,
    };
    const loop = createOutboxWorkerLoop({ db: loopDb as never, redis: { publish: vi.fn() }, metrics });
    await loop.step();
    let rendered = await metrics.render();
    expect(rendered).toContain('outbox_worker_health{service="omnihub-worker"} 0');
    expect(rendered).toContain('outbox_worker_consecutive_failures{service="omnihub-worker"} 1');

    await loop.step();
    await loop.stop();
    rendered = await metrics.render();
    expect(rendered).toContain('outbox_events_total{outcome="failed",service="omnihub-worker"} 1');
    expect(rendered).toContain('outbox_batch_duration_seconds_count{service="omnihub-worker",outcome="degraded"} 1');
    expect(rendered).toContain('outbox_pending_count{service="omnihub-worker"} 4');
    expect(rendered).toContain('outbox_dead_letter_total{service="omnihub-worker"}');
    expect(rendered).toContain('outbox_worker_consecutive_failures{service="omnihub-worker"} 0');
    metrics.close();
  });

  it('tracks Socket.IO connection, disconnect, and broadcast metrics cleanly', async () => {
    const metrics = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });
    metrics.setRealtimeConnectedSockets(2);
    metrics.recordRealtimeConnection(true);
    metrics.recordRealtimeConnection(true);
    metrics.recordRealtimeConnection(false);
    metrics.recordRealtimeDisconnect('transport close');
    metrics.recordRealtimeDisconnect('custom_reason_x');
    metrics.recordRealtimeBroadcast('broadcast');
    metrics.recordRealtimeBroadcast('invalid_payload');

    const rendered = await metrics.render();
    expect(rendered).toContain('realtime_connected_sockets{service="omnihub-api"} 2');
    expect(rendered).toContain('realtime_connections_total{outcome="accepted",service="omnihub-api"} 2');
    expect(rendered).toContain('realtime_connections_total{outcome="rejected",service="omnihub-api"} 1');
    expect(rendered).toContain('realtime_disconnects_total{reason="transport_close",service="omnihub-api"} 1');
    expect(rendered).toContain('realtime_disconnects_total{reason="other",service="omnihub-api"} 1');
    expect(rendered).toContain('realtime_events_broadcast_total{outcome="broadcast",service="omnihub-api"} 1');
    expect(rendered).toContain('realtime_events_broadcast_total{outcome="invalid_payload",service="omnihub-api"} 1');
    metrics.close();
  });

  it('protects /metrics behind unproxied loopback check or constant-time Bearer token and handles render errors safely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);

    const metrics = createMetricsRegistry({ service: 'omnihub-api', collectDefaultMetrics: false });
    metrics.recordHttpRequest({ method: 'GET', routePath: '/health', statusCode: 200, durationSeconds: 0.004 });
    let token: string | undefined;
    const handler = createMetricsRequestHandler({ metrics, authToken: () => token });

    const invoke = async (reqOverrides: Record<string, unknown>) => {
      const headers: Record<string, string> = {};
      let status = 0;
      let body: unknown;
      const req = {
        method: 'GET',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        get: (h: string) => (reqOverrides.headers as Record<string, string | undefined> | undefined)?.[h.toLowerCase()],
        ...reqOverrides,
      };
      const res = {
        getHeader: () => undefined,
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        status: (code: number) => {
          status = code;
          return res;
        },
        json: (payload: unknown) => {
          body = payload;
          return res;
        },
        send: (payload: unknown) => {
          body = payload;
          return res;
        },
      };
      await handler(req as never, res as never, vi.fn());
      return { status, headers, body };
    };

    // Denied: remote non-loopback IP
    expect((await invoke({ ip: '198.51.100.10', socket: { remoteAddress: '198.51.100.10' } })).status).toBe(403);
    // Denied: proxied loopback via reverse proxy forwarding headers
    expect((await invoke({ headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403);
    expect((await invoke({ headers: { forwarded: 'for=203.0.113.9' } })).status).toBe(403);
    // Allowed: direct unproxied loopback
    const directOk = await invoke({});
    expect(directOk.status).toBe(200);
    expect(directOk.headers['content-type']).toContain('text/plain');
    expect(directOk.headers['cache-control']).toBe('no-store');
    expect(String(directOk.body)).toContain('http_requests_total');

    // Token mode: reject missing/wrong token even from loopback, accept valid Bearer token even behind proxy
    token = 'scrape-secret-token-32-chars-minimum';
    expect((await invoke({})).status).toBe(403);
    expect((await invoke({ headers: { authorization: 'Bearer wrong-token' } })).status).toBe(403);
    const tokenOk = await invoke({
      ip: '172.29.87.250',
      socket: { remoteAddress: '172.29.87.250' },
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '172.29.87.250' },
    });
    expect(tokenOk.status).toBe(200);

    // Render error returns sanitized 500
    token = undefined;
    const throwingMetrics = {
      ...metrics,
      render: vi.fn().mockRejectedValue(new Error('render fail')),
    };
    const errHandler = createMetricsRequestHandler({ metrics: throwingMetrics });
    const errRes = await new Promise<{ status: number; body: unknown }>(resolve => {
      let status = 0;
      const res = {
        getHeader: () => 'corr-err-1',
        setHeader: vi.fn(),
        status: (code: number) => {
          status = code;
          return res;
        },
        json: (payload: unknown) => {
          resolve({ status, body: payload });
          return res;
        },
        send: vi.fn(),
      };
      void errHandler({ method: 'GET', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, get: () => undefined } as never, res as never, vi.fn());
    });
    expect(errRes.status).toBe(500);
    expect(errRes.body).toMatchObject({ code: 'METRICS_UNAVAILABLE' });
    metrics.close();
  });

  it('rate-limits /metrics with HTTP 429, Retry-After, X-Forwarded-For bypass immunity, IPv4/IPv6 keys, and bounded LRU cleanup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let nowMs = Date.now();
    const store = new BoundedMemoryRateLimitStore({ windowMs: 60_000, maxEntries: 3, now: () => nowMs });
    const metrics = createMetricsRegistry({ service: 'omnihub-worker', collectDefaultMetrics: false });
    const token = 'worker-scrape-secret-token-32-chars';
    const limiter = createMetricsRateLimiter({ store, windowMs: 60_000, limit: 3 });
    const handler = createMetricsRequestHandler({ metrics, authToken: token });

    const runPipeline = async (opts: { remoteAddress: string; headers?: Record<string, string> }) => {
      const resHeaders: Record<string, string> = {};
      let status = 200;
      let body: unknown;
      const req = {
        method: 'GET',
        ip: opts.remoteAddress,
        socket: { remoteAddress: opts.remoteAddress },
        headers: opts.headers ?? {},
        get: (name: string) => opts.headers?.[name.toLowerCase()],
      };
      const res = {
        headersSent: false,
        getHeader: (k: string) => resHeaders[k.toLowerCase()],
        setHeader: (k: string, v: string | number) => {
          resHeaders[k.toLowerCase()] = String(v);
          return res;
        },
        set: (k: string, v: string | number) => {
          resHeaders[k.toLowerCase()] = String(v);
          return res;
        },
        status: (code: number) => {
          status = code;
          return res;
        },
        json: (payload: unknown) => {
          res.headersSent = true;
          body = payload;
          return res;
        },
        send: (payload: unknown) => {
          res.headersSent = true;
          body = payload;
          return res;
        },
      };

      let passedLimiter = false;
      await new Promise<void>(resolve => {
        void limiter(req as never, res as never, () => {
          passedLimiter = true;
          resolve();
        });
        setImmediate(() => {
          if (res.headersSent && !passedLimiter) resolve();
        });
      });

      if (passedLimiter) {
        await handler(req as never, res as never, vi.fn());
      }
      return { status, headers: resHeaders, body };
    };

    // 1. Valid scrapes within limit succeed (200) and keep Prometheus exposition intact
    const authHeaders = { authorization: `Bearer ${token}` };
    const r1 = await runPipeline({ remoteAddress: '127.0.0.1', headers: authHeaders });
    const r2 = await runPipeline({ remoteAddress: '127.0.0.1', headers: authHeaders });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers['content-type']).toContain('text/plain');
    expect(String(r2.body)).toContain('# TYPE outbox_worker_health gauge');

    // 2. Spoofing X-Forwarded-For / Forwarded / X-Real-IP does NOT change bucket or bypass 429
    const r3 = await runPipeline({
      remoteAddress: '::ffff:127.0.0.1',
      headers: { ...authHeaders, 'x-forwarded-for': '198.51.100.77', forwarded: 'for=198.51.100.88' },
    });
    expect(r3.status).toBe(200);
    const r4 = await runPipeline({
      remoteAddress: '127.0.0.1',
      headers: { ...authHeaders, 'x-forwarded-for': '203.0.113.99' },
    });
    expect(r4.status).toBe(429);
    expect(r4.body).toEqual({ code: 'RATE_LIMITED' });
    expect(Number(r4.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r4.headers['retry-after'])).toBeLessThanOrEqual(60);

    // 3. Independent client IP still goes to auth check (unauthenticated 403) before exceeding its own quota
    const unauthOtherIp = await runPipeline({ remoteAddress: '10.0.0.99' });
    expect(unauthOtherIp.status).toBe(403);
    expect(unauthOtherIp.body).toEqual({ code: 'METRICS_ACCESS_DENIED' });

    // 4. Concurrent burst from an independent IPv6 client respects quota cleanly
    const ipv6Results = await Promise.all([
      runPipeline({ remoteAddress: '2001:db8:1:2::10', headers: authHeaders }),
      runPipeline({ remoteAddress: '2001:db8:1:2::20', headers: authHeaders }),
      runPipeline({ remoteAddress: '2001:db8:1:2::30', headers: authHeaders }),
      runPipeline({ remoteAddress: '2001:db8:1:2::40', headers: authHeaders }),
    ]);
    expect(ipv6Results.filter(r => r.status === 200)).toHaveLength(3);
    expect(ipv6Results.filter(r => r.status === 429)).toHaveLength(1);

    // 5. IPv6 /64 normalization shares bucket across hosts in same /64, separates distinct /64s, and hashes IP
    expect(metricsRateLimitKey({ ip: '2001:db8:1:2::1', socket: { remoteAddress: '2001:db8:1:2::1' } } as never))
      .toBe(metricsRateLimitKey({ ip: '2001:db8:1:2::beef', socket: { remoteAddress: '2001:db8:1:2::beef' } } as never));
    expect(metricsRateLimitKey({ ip: '2001:db8:1:2::1', socket: { remoteAddress: '2001:db8:1:2::1' } } as never))
      .not.toBe(metricsRateLimitKey({ ip: '2001:db8:1:3::1', socket: { remoteAddress: '2001:db8:1:3::1' } } as never));
    expect(metricsRateLimitKey({ ip: '::ffff:127.0.0.1', socket: { remoteAddress: '::ffff:127.0.0.1' } } as never))
      .toBe(metricsRateLimitKey({ ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as never));

    // 6. Memory store strictly respects maxEntries=3 across many distinct clients & evicts expired keys
    for (let i = 0; i < 20; i++) {
      store.increment(`flood-client-${i}`);
    }
    expect(store.size).toBe(3);
    nowMs += 65_000;
    expect(store.get('flood-client-19')).toBeUndefined();

    // 7. Logs contain zero raw IPs or auth tokens
    const loggedLines = warnSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(loggedLines).toContain('METRICS_RATE_LIMITED');
    expect(loggedLines).not.toContain('127.0.0.1');
    expect(loggedLines).not.toContain('2001:db8');
    expect(loggedLines).not.toContain('198.51.100.77');
    expect(loggedLines).not.toContain(token);

    // 8. Shutdown clears all store entries cleanly and defaults remain suitable for Prometheus scrapes
    store.shutdown();
    expect(store.size).toBe(0);
    metrics.close();

    const defaults = resolveMetricsRateLimitConfig({});
    expect(defaults).toEqual({ windowMs: 60_000, limit: 120, maxEntries: 1024 });

    // 9. Sustained Prometheus scrapes (20 sequential scrapes) under default 120/min quota succeed 100%
    const promStore = new BoundedMemoryRateLimitStore();
    const promMetrics = createMetricsRegistry({ service: 'omnihub-worker', collectDefaultMetrics: false });
    const promLimiter = createMetricsRateLimiter({ store: promStore });
    const promHandler = createMetricsRequestHandler({ metrics: promMetrics });
    for (let s = 0; s < 20; s++) {
      let scrapeStatus = 0;
      await new Promise<void>(resolve => {
        const res = {
          getHeader: vi.fn().mockReturnValue(undefined),
          setHeader: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          status: (c: number) => {
            scrapeStatus = c;
            return res;
          },
          json: vi.fn().mockReturnThis(),
          send: vi.fn().mockReturnThis(),
        };
        const req = { method: 'GET', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, get: () => undefined };
        void promLimiter(req as never, res as never, () => {
          void Promise.resolve(promHandler(req as never, res as never, vi.fn())).then(() => resolve());
        });
      });
      expect(scrapeStatus).toBe(200);
    }
    promStore.shutdown();
    promMetrics.close();
  });
});
