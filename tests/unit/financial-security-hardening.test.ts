import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
} from '../../apps/api/src/domain';
import { validateDeployment } from '../../apps/api/src/deployment-security';
import {
  createMetricsRegistry,
  normalizeErrorCodeLabel,
} from '../../apps/api/src/observability/metrics';
import {
  processOutboxBatch,
  replayDeadLetterOutbox,
} from '../../apps/api/src/outbox';
import {
  rateLimitRedisReady,
  setRateLimitRedisHealthProbe,
} from '../../apps/api/src/rate-limit';
import { groupSchema, refundDecisionSchema } from '../../packages/contracts/src';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const STORE_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

describe('P0/P1 hardening unit regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('supports async scrypt hashing and maintains full compatibility with existing sync hashes', async () => {
    const syncHash = hashPassword('Pilot-Secure-Password-123!');
    const asyncHashA = await hashPasswordAsync('Pilot-Secure-Password-123!');
    const asyncHashB = await hashPasswordAsync('Pilot-Secure-Password-123!');

    expect(asyncHashA).not.toBe(asyncHashB);
    expect(await verifyPasswordAsync('Pilot-Secure-Password-123!', syncHash)).toBe(true);
    expect(await verifyPasswordAsync('wrong-password', syncHash)).toBe(false);
    expect(verifyPassword('Pilot-Secure-Password-123!', asyncHashA)).toBe(true);
    expect(await verifyPasswordAsync('Pilot-Secure-Password-123!', asyncHashA)).toBe(true);
    expect(await verifyPasswordAsync('Pilot-Secure-Password-123!', 'malformed-hash')).toBe(false);
    expect(await verifyPasswordAsync('Pilot-Secure-Password-123!', 'salt:short')).toBe(false);
  });

  it('returns false from rateLimitRedisReady when the Redis ping probe rejects', async () => {
    setRateLimitRedisHealthProbe(async () => {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    });
    expect(await rateLimitRedisReady()).toBe(false);

    setRateLimitRedisHealthProbe(async () => 'PONG');
    expect(await rateLimitRedisReady()).toBe(true);
  });

  it('exports default Node.js metrics for both API and Worker registries and routes backlog errors to the configured logger', async () => {
    const apiReg = createMetricsRegistry({ service: 'omnihub-api-test', collectDefaultMetrics: true });
    const workerReg = createMetricsRegistry({ service: 'omnihub-worker-test', collectDefaultMetrics: true });
    const apiText = await apiReg.render();
    const workerText = await workerReg.render();

    expect(apiText).toContain('nodejs_');
    expect(apiText).toContain('service="omnihub-api-test"');
    expect(workerText).toContain('nodejs_');
    expect(workerText).toContain('service="omnihub-worker-test"');

    const warnCalls: string[] = [];
    const customLogger = {
      ops: vi.fn((_level: string, event: string) => {
        warnCalls.push(event);
      }),
    };
    const workerWithLogger = createMetricsRegistry({
      service: 'omnihub-worker',
      collectDefaultMetrics: false,
      logger: customLogger as never,
    });
    const failingDb = {
      outbox: {
        count: vi.fn().mockRejectedValue(new Error('db offline')),
        findFirst: vi.fn().mockRejectedValue(new Error('db offline')),
      },
    };
    await workerWithLogger.refreshOutboxBacklog(failingDb as never);
    expect(warnCalls).toContain('METRICS_OUTBOX_REFRESH_FAILED');
    expect(failingDb.outbox.count).toHaveBeenCalledWith({
      where: { deliveredAt: null, deadLetteredAt: null },
    });

    expect(normalizeErrorCodeLabel('INVALID_JSON_BODY')).toBe('INVALID_JSON_BODY');
    expect(normalizeErrorCodeLabel('RESOURCE_NOT_FOUND')).toBe('RESOURCE_NOT_FOUND');
    expect(normalizeErrorCodeLabel('CONCURRENCY_CONFLICT')).toBe('CONCURRENCY_CONFLICT');
    expect(normalizeErrorCodeLabel('INVALID_REFERENCE_OR_INPUT')).toBe('INVALID_REFERENCE_OR_INPUT');

    apiReg.close();
    workerReg.close();
    workerWithLogger.close();
  });

  it('rejects SEED_DEMO=true in production and validates hardened contract schemas', () => {
    expect(() =>
      validateDeployment({
        NODE_ENV: 'production',
        SEED_DEMO: 'true',
        WEB_ORIGIN: 'https://omnihub.example',
        SESSION_SECURE: 'true',
        QR_TOKEN_SECRET: 'a'.repeat(64),
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        REDIS_URL: 'rediss://user:' + 'r'.repeat(32) + '@redis.example:6379',
        DATABASE_URL: 'postgresql://user:' + 'p'.repeat(32) + '@db.example:5432/omnihub?sslmode=verify-full',
      }),
    ).toThrow('UNSAFE_DEPLOYMENT_SEED_DEMO');

    expect(
      refundDecisionSchema.safeParse({
        decision: 'APPROVED',
        reason: 'Manager verified cash refund',
        shiftId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
    expect(
      refundDecisionSchema.safeParse({
        decision: 'APPROVED',
        reason: 'Manager verified cash refund',
        shiftId: 'not-a-uuid',
      }).success,
    ).toBe(false);
    expect(
      groupSchema.safeParse({ name: 'Size', active: true, minSelections: 2, maxSelections: 1 }).success,
    ).toBe(false);
    expect(
      groupSchema.safeParse({ name: 'Size', active: true, minSelections: 1, maxSelections: 2 }).success,
    ).toBe(true);
  });

  it('persists exponential retry backoff, transitions exhausted outbox events to durable DLQ, and replays them safely', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const metrics = createMetricsRegistry({ service: 'omnihub-worker', collectDefaultMetrics: false });
    const executedStatements: unknown[] = [];

    const makeFakeDb = (attempts: number, maxAttempts: number) =>
      ({
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: vi.fn(async () => [
              {
                id: eventId,
                tenantId: TENANT_ID,
                storeId: STORE_ID,
                type: 'order.accepted',
                aggregateId: ORDER_ID,
                version: 1,
                correlationId: 'corr-retry',
                createdAt: new Date(),
                attempts,
                maxAttempts,
              },
            ]),
            $executeRaw: vi.fn(async (sqlObj: unknown) => {
              executedStatements.push(sqlObj);
              return 1;
            }),
            outbox: {
              updateMany: vi.fn(async () => ({ count: 0 })),
            },
          }),
      }) as unknown as PrismaClient;

    const failingRedis = { publish: vi.fn(async () => { throw new Error('REDIS_TRANSIENT'); }) };

    // Attempt 1 of 2 -> scheduled for retry with exponential backoff (not yet dead-lettered)
    const retryRes = await processOutboxBatch({
      db: makeFakeDb(0, 2),
      redis: failingRedis,
      retryBaseBackoffMs: 500,
      retryMaxBackoffMs: 15_000,
      now: () => 1_700_000_000_000,
      metrics,
    });
    expect(retryRes.retried).toBe(1);
    expect(retryRes.deadLettered).toBeUndefined();
    expect(retryRes.error?.message).toBe('REDIS_TRANSIENT');
    expect(executedStatements).toHaveLength(1);

    // Attempt 2 of 2 -> max retries reached -> moved to durable DLQ
    const quarantinedIds = new Set<string>();
    const dlqRes = await processOutboxBatch({
      db: makeFakeDb(1, 2),
      redis: failingRedis,
      quarantinedIds,
      metrics,
    });
    expect(dlqRes.deadLettered).toBe(1);
    expect(quarantinedIds.has(eventId)).toBe(true);
    expect(executedStatements).toHaveLength(2);

    // Safe DLQ replay clears deadLetteredAt and removes from in-memory quarantine
    const replayDb = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          outbox: {
            findMany: vi.fn(async () => [{ id: eventId }]),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
        }),
    } as unknown as PrismaClient;
    const replayed = await replayDeadLetterOutbox(replayDb, {
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      ids: [eventId],
      quarantinedIds,
      metrics,
    });
    expect(replayed).toEqual({ replayed: 1, ids: [eventId] });
    expect(quarantinedIds.has(eventId)).toBe(false);

    const rendered = await metrics.render();
    expect(rendered).toContain('outbox_events_total{outcome="dead_lettered",service="omnihub-worker"} 1');
    expect(rendered).toContain('outbox_events_total{outcome="replayed",service="omnihub-worker"} 1');
    metrics.close();
  });
});
