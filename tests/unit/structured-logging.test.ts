import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, authEmailHmacPrefix, reauthorize } from '../../apps/api/src/auth';
import { digest } from '../../apps/api/src/domain';
import { Errors } from '../../apps/api/src/errors';
import { createHttpSecurityLoggingMiddleware } from '../../apps/api/src/observability/http-middleware';
import {
  createStructuredLogger,
  isSensitiveFieldName,
  REDACTED_VALUE,
  resolveLogLevel,
  sanitizeLogValue,
  scrubSensitiveString,
  type LogLevel,
  type LogSink,
} from '../../apps/api/src/observability/logger';
import { getLogContext, resolveCorrelationId, runWithLogContext, updateLogContext } from '../../apps/api/src/observability/request-context';
import { createRedisRateLimiter } from '../../apps/api/src/rate-limit';

function createMemorySink() {
  const entries: Array<{ level: LogLevel; serialized: string; parsed: Record<string, unknown> }> = [];
  const sink: LogSink = {
    write(level, serialized) {
      entries.push({
        level,
        serialized,
        parsed: JSON.parse(serialized) as Record<string, unknown>,
      });
    },
  };
  return { entries, sink };
}

function mustAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}`);
  return item;
}

describe('structured logging architecture (M2-T01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits valid JSON envelope records across application, security, and operational categories', () => {
    const { entries, sink } = createMemorySink();
    const root = createStructuredLogger({ service: 'omnihub-api', level: 'info', sink });

    root.info('ORDER_CREATED', { component: 'orders', orderId: 'ord-1', totalVnd: 125000 });
    root.security('warn', 'LOGIN_BLOCKED', { storeId: 'store-1', reason: 'RATE_LIMITED' });
    root.child({ component: 'outbox', defaultCategory: 'operational' }).error('OUTBOX_FAILED', { attempt: 2 });

    expect(entries).toHaveLength(3);
    const e0 = mustAt(entries, 0);
    const e1 = mustAt(entries, 1);
    const e2 = mustAt(entries, 2);

    expect(e0.parsed).toMatchObject({
      level: 'info',
      category: 'application',
      service: 'omnihub-api',
      component: 'orders',
      code: 'ORDER_CREATED',
      orderId: 'ord-1',
      totalVnd: 125000,
    });
    expect(typeof e0.parsed.timestamp).toBe('string');
    expect(() => new Date(e0.parsed.timestamp as string).toISOString()).not.toThrow();

    expect(e1.parsed).toMatchObject({
      level: 'warn',
      category: 'security',
      service: 'omnihub-api',
      code: 'LOGIN_BLOCKED',
      storeId: 'store-1',
      reason: 'RATE_LIMITED',
    });

    expect(e2.parsed).toMatchObject({
      level: 'error',
      category: 'operational',
      service: 'omnihub-api',
      component: 'outbox',
      code: 'OUTBOX_FAILED',
      attempt: 2,
    });

    // Envelope keys passed inside custom fields must not spoof structured envelope metadata.
    root.info('SAFE_ENVELOPE', { level: 'fatal', service: 'spoofed', category: 'security', customFlag: true });
    expect(mustAt(entries, 3).parsed).toMatchObject({
      level: 'info',
      category: 'application',
      service: 'omnihub-api',
      code: 'SAFE_ENVELOPE',
      customFlag: true,
    });
  });

  it('filters log records below configured threshold before reading or serializing fields', () => {
    const { entries, sink } = createMemorySink();
    let currentLevel: LogLevel = 'warn';
    const logger = createStructuredLogger({
      service: 'omnihub-api',
      level: () => currentLevel,
      sink,
    });

    const expensiveGetter = vi.fn(() => 'should-not-run');
    const suppressedPayload = Object.defineProperty({}, 'computed', {
      enumerable: true,
      get: expensiveGetter,
    });

    logger.debug('DEBUG_IGNORED', suppressedPayload);
    logger.info('INFO_IGNORED', suppressedPayload);
    expect(entries).toHaveLength(0);
    expect(expensiveGetter).not.toHaveBeenCalled();
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('warn')).toBe(true);

    logger.warn('WARN_EMITTED', { ok: true });
    expect(entries).toHaveLength(1);

    currentLevel = 'debug';
    logger.debug('DEBUG_NOW_ENABLED', { step: 1 });
    expect(entries).toHaveLength(2);

    expect(resolveLogLevel(' WARN ')).toBe('warn');
    expect(resolveLogLevel('invalid-level')).toBe('info');
    expect(resolveLogLevel(undefined)).toBe('info');
  });

  it('validates correlation IDs and replaces unsafe or malformed headers with UUID v4', () => {
    const valid = resolveCorrelationId('  req-2026.abc_01  ');
    expect(valid).toBe('req-2026.abc_01');

    for (const unsafe of ['short', 'x'.repeat(65), 'bad\r\nid-value', 'has spaces 1234', undefined]) {
      const generated = resolveCorrelationId(unsafe);
      expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it('isolates AsyncLocalStorage context across concurrent async requests and enriches context via updateLogContext', async () => {
    const { entries, sink } = createMemorySink();
    const logger = createStructuredLogger({ service: 'omnihub-api', sink });

    expect(getLogContext()).toBeUndefined();

    const simulateRequest = (req: { correlationId: string; tenantId: string; storeId: string; userId: string; delayMs: number }) =>
      runWithLogContext({ correlationId: req.correlationId, service: 'omnihub-api', component: 'http' }, async () => {
        await new Promise(resolve => setTimeout(resolve, req.delayMs));
        updateLogContext({ tenantId: req.tenantId, storeId: req.storeId, userId: req.userId });
        await new Promise(resolve => setTimeout(resolve, 10 - req.delayMs));
        logger.info('REQUEST_COMPLETED', { handler: req.tenantId });
      });

    await Promise.all([
      simulateRequest({ correlationId: 'corr-tenant-a-11', tenantId: 't-alpha', storeId: 's-alpha', userId: 'u-alpha', delayMs: 8 }),
      simulateRequest({ correlationId: 'corr-tenant-b-22', tenantId: 't-beta', storeId: 's-beta', userId: 'u-beta', delayMs: 2 }),
    ]);

    expect(getLogContext()).toBeUndefined();
    expect(entries).toHaveLength(2);

    const alpha = entries.find(e => e.parsed.handler === 't-alpha')?.parsed;
    const beta = entries.find(e => e.parsed.handler === 't-beta')?.parsed;
    expect(alpha).toMatchObject({
      correlationId: 'corr-tenant-a-11',
      tenantId: 't-alpha',
      storeId: 's-alpha',
      userId: 'u-alpha',
    });
    expect(beta).toMatchObject({
      correlationId: 'corr-tenant-b-22',
      tenantId: 't-beta',
      storeId: 's-beta',
      userId: 'u-beta',
    });
  });

  it('propagates worker batch metadata while preserving explicit per-event correlationId', () => {
    const { entries, sink } = createMemorySink();
    const worker = createStructuredLogger({
      service: 'omnihub-worker',
      defaultCategory: 'operational',
      component: 'outbox-worker',
      sink,
    });

    runWithLogContext(
      {
        correlationId: 'batch-loop-corr-01',
        service: 'omnihub-worker',
        component: 'outbox-worker',
        jobName: 'outbox-batch',
        batchId: 'batch-42',
      },
      () => {
        worker.info('OUTBOX_BATCH_STARTED', { batchSize: 10 });
        worker.warn('OUTBOX_RETRY', { correlationId: 'order-req-corr-99', eventId: 'evt-7', attempt: 1 });
      },
    );

    expect(entries).toHaveLength(2);
    expect(mustAt(entries, 0).parsed).toMatchObject({
      correlationId: 'batch-loop-corr-01',
      jobName: 'outbox-batch',
      batchId: 'batch-42',
      batchSize: 10,
    });
    expect(mustAt(entries, 1).parsed).toMatchObject({
      correlationId: 'order-req-corr-99',
      jobName: 'outbox-batch',
      batchId: 'batch-42',
      eventId: 'evt-7',
      attempt: 1,
    });
  });

  it('redacts sensitive keys via denylist, scrubs secret patterns, handles circular objects, and enforces optional allowlist', () => {
    const { entries, sink } = createMemorySink();
    const allowlistedLogger = createStructuredLogger({
      service: 'omnihub-api',
      allowedFields: new Set(['orderId', 'path', 'password', 'note']),
      sink,
    });

    // Construct synthetic secret strings dynamically so source hygiene scanner finds zero literal tokens.
    const fakeHexToken = 'a'.repeat(64);
    const fakeGithubToken = ['ghp', '_'].join('') + 'x'.repeat(24);
    const fakeStripeKey = ['sk', '_live_'].join('') + 'y'.repeat(20);
    const fakeDbUrl = ['postgres://app:', 'supersecret', '@db.internal:5432/omnihub'].join('');
    const circular: Record<string, unknown> = { ok: 1 };
    circular.self = circular;

    expect(isSensitiveFieldName('passwordHash')).toBe(true);
    expect(isSensitiveFieldName('hmacSignature')).toBe(true);
    expect(isSensitiveFieldName('rawBody')).toBe(true);
    expect(isSensitiveFieldName('orderId')).toBe(false);

    allowlistedLogger.info('SENSITIVE_TEST', {
      orderId: 'ord-123',
      password: 'plain-password',
      unapprovedField: 'should-be-dropped-by-allowlist',
      path: `/public/qr/${fakeHexToken}/orders`,
      note: `Bearer ${fakeHexToken}; cookie token=${fakeGithubToken}; key=${fakeStripeKey}; db=${fakeDbUrl}`,
    });

    expect(entries).toHaveLength(1);
    const record = mustAt(entries, 0).parsed;
    expect(record.orderId).toBe('ord-123');
    expect(record.password).toBe(REDACTED_VALUE);
    expect(record).not.toHaveProperty('unapprovedField');
    expect(record.path).toBe('/public/qr/:credential/orders');
    expect(String(record.note)).not.toContain(fakeHexToken);
    expect(String(record.note)).not.toContain(fakeGithubToken);
    expect(String(record.note)).not.toContain(fakeStripeKey);
    expect(String(record.note)).not.toContain('supersecret');

    const sanitized = sanitizeLogValue({
      nested: { sessionToken: 'abc', cvv: '999', err: new Error('db password leaked'), circular },
    }) as { nested: Record<string, unknown> };
    expect(sanitized.nested.sessionToken).toBe(REDACTED_VALUE);
    expect(sanitized.nested.cvv).toBe(REDACTED_VALUE);
    expect(sanitized.nested.err).toEqual({ errorType: 'Error' });
    expect((sanitized.nested.circular as Record<string, unknown>).self).toBe('[Circular]');
    expect(scrubSensitiveString(`Authorization: Bearer ${fakeHexToken}`)).toBe(`Authorization: Bearer ${REDACTED_VALUE}`);
  });

  it('routes Errors filter and rate limiter operational/security logs through StructuredLogger', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let responseBody: unknown;
    const response = {
      getHeader: vi.fn().mockReturnValue(undefined),
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: unknown) => {
        responseBody = body;
      }),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', originalUrl: '/orders?token=secret', header: () => 'corr-filter-01' }),
        getResponse: () => response,
      }),
    };
    runWithLogContext({ correlationId: 'corr-filter-01', service: 'omnihub-api', component: 'http' }, () => {
      new Errors().catch(new Error(['postgresql://', 'user:secret', '@host/db'].join('')), host as never);
    });
    expect(responseBody).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', correlationId: 'corr-filter-01' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const filterLog = JSON.parse(String(mustAt(errorSpy.mock.calls, 0)[0])) as Record<string, unknown>;
    expect(filterLog).toMatchObject({
      category: 'operational',
      level: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      correlationId: 'corr-filter-01',
      errorType: 'Error',
    });

    const limiter = createRedisRateLimiter(
      {
        eval: vi.fn().mockResolvedValue([6, 60000]),
      } as never,
      { prefix: 'api_public', limit: 5, windowMs: 60000 },
    );
    const req = { ip: '127.0.0.1', socket: {}, header: () => 'corr-rate-01' };
    await new Promise<void>(resolve => {
      const res = {
        getHeader: vi.fn().mockReturnValue('corr-rate-01'),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(() => {
          resolve();
        }),
      };
      limiter(req as never, res as never, vi.fn());
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const rateLog = JSON.parse(String(mustAt(warnSpy.mock.calls, 0)[0])) as Record<string, unknown>;
    expect(rateLog).toMatchObject({
      category: 'security',
      level: 'warn',
      code: 'RATE_LIMITED',
      correlationId: 'corr-rate-01',
    });

    const failingLimiter = createRedisRateLimiter(
      {
        eval: vi.fn().mockRejectedValue(new Error('redis down')),
      } as never,
      { prefix: 'login', limit: 5, windowMs: 60000 },
    );
    await new Promise<void>(resolve => {
      const res = {
        getHeader: vi.fn().mockReturnValue('corr-rate-err-02'),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(() => {
          resolve();
        }),
      };
      failingLimiter(req as never, res as never, vi.fn());
    });
    expect(errorSpy).toHaveBeenCalledTimes(2);
    const rateErrLog = JSON.parse(String(mustAt(errorSpy.mock.calls, 1)[0])) as Record<string, unknown>;
    expect(rateErrLog).toMatchObject({
      category: 'operational',
      level: 'error',
      code: 'RATE_LIMITER_UNAVAILABLE',
      errorType: 'Error',
      correlationId: 'corr-rate-err-02',
    });
  });

  it('never crashes callers on sink failures and awaits pending async writes on flush/close', async () => {
    const onWriteError = vi.fn();
    const throwingLogger = createStructuredLogger({
      service: 'omnihub-api',
      sink: {
        write() {
          throw new Error('sink disk full');
        },
      },
      onWriteError,
    });

    expect(() => throwingLogger.error('DISK_TEST', { a: 1 })).not.toThrow();
    expect(throwingLogger.getFailureCount()).toBe(1);
    expect(onWriteError).toHaveBeenCalledTimes(1);

    let flushedCount = 0;
    let closeCalled = 0;
    const asyncLogger = createStructuredLogger({
      service: 'omnihub-worker',
      sink: {
        async write() {
          await new Promise(resolve => setTimeout(resolve, 15));
          flushedCount++;
        },
        async flush() {
          flushedCount += 10;
        },
        async close() {
          closeCalled++;
        },
      },
    });

    asyncLogger.info('BEFORE_SHUTDOWN');
    await asyncLogger.close();
    asyncLogger.info('AFTER_SHUTDOWN_IGNORED');
    await asyncLogger.close();

    expect(flushedCount).toBe(11);
    expect(closeCalled).toBe(1);
  });

  it('propagates correlation headers, tenant enrichment on finish, and logs ORIGIN_DENIED in HTTP middleware', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createHttpSecurityLoggingMiddleware('http://localhost:3000', true);

    const makeRes = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        body?: unknown;
        setHeader: (k: string, v: string) => void;
        status: (code: number) => typeof res;
        json: (payload: unknown) => typeof res;
      };
      res.statusCode = 200;
      res.headers = {};
      res.setHeader = (k: string, v: string) => {
        res.headers[k.toLowerCase()] = v;
      };
      res.status = (code: number) => {
        res.statusCode = code;
        return res;
      };
      res.json = (payload: unknown) => {
        res.body = payload;
        return res;
      };
      return res;
    };

    // 1. Valid correlation ID + tenant enrichment during downstream handler
    const res1 = makeRes();
    const req1 = {
      method: 'POST',
      originalUrl: `/public/qr/${'b'.repeat(64)}/orders?table=1`,
      get: (h: string) => {
        const lower = h.toLowerCase();
        if (lower === 'x-correlation-id') return 'http-corr-valid-01';
        if (lower === 'origin') return 'http://localhost:3000';
        return undefined;
      },
    };
    middleware(req1 as never, res1 as never, () => {
      updateLogContext({ tenantId: 't-http', storeId: 's-http', userId: 'u-http' });
    });
    res1.emit('finish');

    expect(res1.headers['x-correlation-id']).toBe('http-corr-valid-01');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mustAt(logSpy.mock.calls, 0)[0]))).toMatchObject({
      category: 'application',
      level: 'info',
      code: 'HTTP_ACCESS',
      method: 'POST',
      path: '/public/qr/:credential/orders',
      status: 200,
      correlationId: 'http-corr-valid-01',
      tenantId: 't-http',
      storeId: 's-http',
      userId: 'u-http',
    });

    // 2. Malformed correlation ID + bad Origin rejection
    const res2 = makeRes();
    const req2 = {
      method: 'POST',
      originalUrl: '/orders',
      get: (h: string) => {
        const lower = h.toLowerCase();
        if (lower === 'x-correlation-id') return 'bad\r\ninject';
        if (lower === 'origin') return 'https://evil.example';
        return undefined;
      },
    };
    const next2 = vi.fn();
    middleware(req2 as never, res2 as never, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(403);
    expect(res2.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(mustAt(warnSpy.mock.calls, 0)[0]))).toMatchObject({
      category: 'security',
      level: 'warn',
      code: 'ORIGIN_DENIED',
      correlationId: res2.headers['x-correlation-id'],
    });
  });

  it('uses keyed HMAC rather than plain SHA-256 for failed-login email identifiers', () => {
    const email = 'owner@restaurant.test';
    const plainDigestPrefix = digest(email).slice(0, 16);
    const prevLogHmac = process.env.LOG_HMAC_SECRET;
    try {
      delete process.env.LOG_HMAC_SECRET;
      const ephemeralHmac = authEmailHmacPrefix(email);
      expect(ephemeralHmac).toMatch(/^[a-f0-9]{16}$/);
      expect(ephemeralHmac).not.toBe(plainDigestPrefix);

      process.env.LOG_HMAC_SECRET = 'test-log-hmac-secret-key-at-least-32-chars';
      const firstKeyed = authEmailHmacPrefix(email);
      const secondKeyed = authEmailHmacPrefix(email);
      expect(firstKeyed).toBe(secondKeyed);
      expect(firstKeyed).not.toBe(plainDigestPrefix);
      expect(firstKeyed).not.toBe(ephemeralHmac);
    } finally {
      if (prevLogHmac === undefined) delete process.env.LOG_HMAC_SECRET;
      else process.env.LOG_HMAC_SECRET = prevLogHmac;
    }
  });

  it('scrubs full URL credentials, username-less Redis URLs, Basic auth, sensitive query params, binaries, and blocks prototype keys', () => {
    const { entries, sink } = createMemorySink();
    const logger = createStructuredLogger({ service: 'omnihub-api', sink });

    const fakeQrSecret = 'c'.repeat(64);
    const fullQrUrl = ['https://', 'admin:topsecret', '@api.omnihub.test/public/qr/', fakeQrSecret, '/orders?token=shorttok&ok=1'].join('');
    const redisNoUserUrl = ['redis://', ':redispass123', '@redis.internal:6379/0'].join('');
    const protoPayload = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":{"bad":1}},"safe":"ok"}') as Record<string, unknown>;

    logger.info('BYPASS_REGRESSION_CHECK', {
      url: fullQrUrl,
      target: redisNoUserUrl,
      header: 'Basic dXNlcjpwYXNzMTIz',
      queryNote: 'callback https://host.test/cb?signature=sig123&x-qr-token=qtok',
      rawPayloadBuf: Buffer.from('raw-secret-bytes'),
      cvc: '842',
      protoPayload,
    });

    expect(entries).toHaveLength(1);
    const serialized = mustAt(entries, 0).serialized;
    const parsed = mustAt(entries, 0).parsed;
    expect(serialized).not.toContain('topsecret');
    expect(serialized).not.toContain('redispass123');
    expect(serialized).not.toContain('dXNlcjpwYXNzMTIz');
    expect(serialized).not.toContain('shorttok');
    expect(serialized).not.toContain('sig123');
    expect(serialized).not.toContain('qtok');
    expect(serialized).not.toContain(fakeQrSecret);
    expect(parsed.url).toBe(`https://${REDACTED_VALUE}:${REDACTED_VALUE}@api.omnihub.test/public/qr/:credential/orders`);
    expect(parsed.rawPayloadBuf).toBe('[Binary Redacted]');
    expect(parsed.cvc).toBe(REDACTED_VALUE);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((parsed.protoPayload as Record<string, unknown>).safe).toBe('ok');
  });

  it('prevents untrusted payload fields from overwriting AsyncLocalStorage tenant/user/batch or injecting malformed correlationId', () => {
    const { entries, sink } = createMemorySink();
    const logger = createStructuredLogger({
      service: 'omnihub-api',
      allowedFields: new Set(['action']),
      sink,
    });

    runWithLogContext(
      {
        correlationId: 'ctx-corr-valid-01',
        service: 'omnihub-api',
        component: 'http',
        tenantId: 'tenant-real',
        storeId: 'store-real',
        userId: 'user-real',
        jobName: 'job-real',
        batchId: 'batch-real',
      },
      () => {
        logger.info('SPOOF_ATTEMPT', {
          action: 'update',
          tenantId: 'tenant-victim',
          storeId: 'store-victim',
          userId: 'user-victim',
          jobName: 'job-victim',
          batchId: 'batch-victim',
          correlationId: '',
          unapproved: 'drop-me',
        });
        logger.info('SPOOF_CRLF_CORRELATION', {
          action: 'retry',
          correlationId: 'evil\r\nid-value',
        });
      },
    );

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.parsed).toMatchObject({
        correlationId: 'ctx-corr-valid-01',
        tenantId: 'tenant-real',
        storeId: 'store-real',
        userId: 'user-real',
        jobName: 'job-real',
        batchId: 'batch-real',
      });
      expect(entry.parsed).not.toHaveProperty('unapproved');
    }
  });

  it('deduplicates concurrent close(), enforces async write backpressure cap, and bounds flush on stalled sinks', async () => {
    let sinkCloseCalls = 0;
    const errors: unknown[] = [];
    const gates: Array<() => void> = [];
    const logger = createStructuredLogger({
      service: 'omnihub-worker',
      maxPendingWrites: 2,
      flushTimeoutMs: 40,
      onWriteError: err => errors.push(err),
      sink: {
        write() {
          return new Promise<void>(resolve => {
            gates.push(resolve);
          });
        },
        async close() {
          sinkCloseCalls++;
        },
      },
    });

    // Two async writes enter queue; third hits maxPendingWrites=2 backpressure limit.
    logger.info('QUEUED_1');
    logger.info('QUEUED_2');
    logger.info('DROPPED_BACKPRESSURE');
    expect(logger.getFailureCount()).toBe(1);
    expect(errors).toHaveLength(1);

    // Concurrent close() calls share one lifecycle and reject new mid-flush writes.
    const closing = Promise.all([logger.close(), logger.close()]);
    logger.info('IGNORED_WHILE_CLOSING');
    await closing;

    expect(sinkCloseCalls).toBe(1);
    expect(gates).toHaveLength(2);
    for (const release of gates) release();
  });

  it('omits correlationId in rate limiter logs when header is absent and records primitive error types cleanly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = { ip: '127.0.0.1', socket: {} };

    const blockedLimiter = createRedisRateLimiter(
      { eval: vi.fn().mockResolvedValue([6, 60_000]) } as never,
      { prefix: 'api_public', limit: 5, windowMs: 60_000 },
    );
    await new Promise<void>(resolve => {
      const res = {
        getHeader: vi.fn().mockReturnValue(undefined),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(() => resolve()),
      };
      blockedLimiter(req as never, res as never, vi.fn());
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const blockedLog = JSON.parse(String(mustAt(warnSpy.mock.calls, 0)[0])) as Record<string, unknown>;
    expect(blockedLog).toMatchObject({ category: 'security', level: 'warn', code: 'RATE_LIMITED' });
    expect(blockedLog).not.toHaveProperty('correlationId');

    const stringFailLimiter = createRedisRateLimiter(
      { eval: vi.fn().mockRejectedValue('redis-timeout-string') } as never,
      { prefix: 'login', limit: 5, windowMs: 60_000 },
    );
    await new Promise<void>(resolve => {
      const res = {
        getHeader: vi.fn().mockReturnValue(undefined),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(() => resolve()),
      };
      stringFailLimiter(req as never, res as never, vi.fn());
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errLog = JSON.parse(String(mustAt(errorSpy.mock.calls, 0)[0])) as Record<string, unknown>;
    expect(errLog).toMatchObject({
      category: 'operational',
      level: 'error',
      code: 'RATE_LIMITER_UNAVAILABLE',
      errorType: 'string',
    });
    expect(errLog).not.toHaveProperty('correlationId');
  });

  it('falls back to AsyncLocalStorage correlationId across auth rejections and omits empty correlationId outside scope', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validToken = 'd'.repeat(64);
    const future = new Date(Date.now() + 60_000);

    // 1. Missing session inside active AsyncLocalStorage context -> inherits ALS correlationId
    const notFoundDb = {
      session: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await runWithLogContext({ correlationId: 'corr-auth-als-01', service: 'omnihub-api', component: 'http' }, async () => {
      await expect(authenticate(notFoundDb as never, validToken)).rejects.toThrow('SESSION_EXPIRED');
    });
    expect(JSON.parse(String(mustAt(warnSpy.mock.calls, 0)[0]))).toMatchObject({
      code: 'AUTH_SESSION_REJECTED',
      reason: 'SESSION_NOT_FOUND',
      correlationId: 'corr-auth-als-01',
    });

    // 2. Inactive user outside ALS scope and no correlationId argument -> omits correlationId field
    const inactiveDb = {
      session: {
        findUnique: vi.fn().mockResolvedValue({
          userId: 'u-1',
          storeId: 's-1',
          tenantId: 't-1',
          expiresAt: future,
          user: { active: false },
        }),
      },
    };
    await expect(authenticate(inactiveDb as never, validToken)).rejects.toThrow('SESSION_EXPIRED');
    const inactiveLog = JSON.parse(String(mustAt(warnSpy.mock.calls, 1)[0])) as Record<string, unknown>;
    expect(inactiveLog).toMatchObject({ code: 'AUTH_SESSION_REJECTED', reason: 'USER_INACTIVE' });
    expect(inactiveLog).not.toHaveProperty('correlationId');

    // 3. Membership denied outside ALS scope -> omits correlationId
    const noMemberDb = {
      session: {
        findUnique: vi.fn().mockResolvedValue({
          userId: 'u-1',
          storeId: 's-1',
          tenantId: 't-1',
          expiresAt: future,
          user: { active: true },
        }),
      },
      membership: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(authenticate(noMemberDb as never, validToken)).rejects.toThrow('MEMBERSHIP_REQUIRED');
    const noMemberLog = JSON.parse(String(mustAt(warnSpy.mock.calls, 2)[0])) as Record<string, unknown>;
    expect(noMemberLog).toMatchObject({ code: 'AUTH_MEMBERSHIP_DENIED', tenantId: 't-1', storeId: 's-1', userId: 'u-1' });
    expect(noMemberLog).not.toHaveProperty('correlationId');

    // 4. Reauthorize revoked with empty ctx.correlationId -> omits correlationId
    const revokedTx = {
      session: { findUnique: vi.fn().mockResolvedValue(null) },
      membership: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      reauthorize(revokedTx as never, {
        tenantId: 't-1',
        storeId: 's-1',
        userId: 'u-1',
        role: 'CASHIER',
        tokenHash: digest(validToken),
        expiresAt: future,
        correlationId: '',
      }),
    ).rejects.toThrow('SESSION_REVOKED');
    const revokedLog = JSON.parse(String(mustAt(warnSpy.mock.calls, 3)[0])) as Record<string, unknown>;
    expect(revokedLog).toMatchObject({ code: 'AUTH_REAUTHORIZE_REVOKED', tenantId: 't-1', storeId: 's-1', userId: 'u-1' });
    expect(revokedLog).not.toHaveProperty('correlationId');
  });
});
