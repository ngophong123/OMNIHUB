import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { eventSchema } from '@omnihub/contracts';
import { workerLogger } from './observability/logger';
import { type MetricsCollector, type OutboxBacklogReader, workerMetrics } from './observability/metrics';
import { runWithLogContext } from './observability/request-context';

export const OUTBOX_CHANNEL = 'omnihub.events';
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
export const DEFAULT_BATCH_TIME_BUDGET_MS = 10_000;
export const DEFAULT_TX_COMMIT_HEADROOM_MS = 5_000;
export const DEFAULT_TX_TIMEOUT_MS = 15_000;
export const DEFAULT_BASE_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_QUARANTINE_IDS = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OutboxRow = {
  id: string;
  tenantId: string;
  storeId: string;
  type: string;
  aggregateId: string;
  version: number;
  correlationId: string;
  createdAt: Date;
  attempts?: number;
  maxAttempts?: number;
};

export type OutboxPublisher = {
  publish(channel: string, message: string): Promise<number>;
  ping?(): Promise<string>;
};

export type OutboxBatchOptions = {
  db: PrismaClient;
  redis: OutboxPublisher;
  channel?: string;
  batchSize?: number;
  publishTimeoutMs?: number;
  batchTimeBudgetMs?: number;
  transactionTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseBackoffMs?: number;
  retryMaxBackoffMs?: number;
  now?: () => number;
  quarantinedIds?: Set<string>;
  tenantIds?: readonly string[];
  shouldContinue?: () => boolean;
  metrics?: MetricsCollector;
};

export type OutboxBatchResult = {
  claimed: number;
  delivered: number;
  quarantined: number;
  retried?: number;
  deadLettered?: number;
  budgetExceeded?: boolean;
  error?: Error;
};

class PublishTimeoutError extends Error {
  constructor(public readonly reason: 'publish_timeout' | 'batch_budget') {
    super(reason === 'batch_budget' ? 'OUTBOX_BATCH_BUDGET_EXCEEDED' : 'OUTBOX_PUBLISH_TIMEOUT');
    this.name = 'PublishTimeoutError';
  }
}

function sanitizeOutboxError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/[a-f0-9]{64}/gi, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 200) || 'OUTBOX_PUBLISH_FAILED';
}

/** Resolves per-event publish timeout, bounded batch time budget, and Prisma tx deadline with commit headroom. */
export function resolveOutboxTiming(options: {
  publishTimeoutMs?: number;
  batchTimeBudgetMs?: number;
  transactionTimeoutMs?: number;
}): {
  publishTimeoutMs: number;
  batchTimeBudgetMs: number;
  transactionTimeoutMs: number;
} {
  const publishTimeoutMs = Math.max(1, options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS);
  const requestedBudget = options.batchTimeBudgetMs;
  const defaultBudget = Math.max(DEFAULT_BATCH_TIME_BUDGET_MS, publishTimeoutMs);

  const transactionTimeoutMs =
    options.transactionTimeoutMs !== undefined
      ? Math.max(10, options.transactionTimeoutMs)
      : Math.max(
          DEFAULT_TX_TIMEOUT_MS,
          (requestedBudget ?? defaultBudget) + DEFAULT_TX_COMMIT_HEADROOM_MS,
        );

  const commitHeadroomMs = Math.min(
    DEFAULT_TX_COMMIT_HEADROOM_MS,
    Math.max(1, Math.floor(transactionTimeoutMs / 3)),
  );
  const maxSafeBudgetMs = Math.max(1, transactionTimeoutMs - commitHeadroomMs);
  const batchTimeBudgetMs = Math.max(
    1,
    Math.min(requestedBudget ?? defaultBudget, maxSafeBudgetMs),
  );

  return { publishTimeoutMs, batchTimeBudgetMs, transactionTimeoutMs };
}

/** Computes bounded exponential backoff with jitter across consecutive transient failures. */
export function computeBackoffMs(
  consecutiveFailures: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(10, consecutiveFailures - 1);
  const ceiling = Math.min(maxMs, baseMs * Math.pow(2, exponent));
  const jittered = Math.round(ceiling * (0.75 + 0.25 * Math.min(1, Math.max(0, random()))));
  return Math.min(maxMs, Math.max(baseMs, jittered));
}

function quarantineId(set: Set<string>, id: string): void {
  if (set.size >= MAX_QUARANTINE_IDS) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(id);
}

async function publishWithTimeout(
  publisher: OutboxPublisher,
  channel: string,
  payload: string,
  timeoutMs: number,
  reason: 'publish_timeout' | 'batch_budget' = 'publish_timeout',
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publisher.publish(channel, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PublishTimeoutError(reason)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Atomically claims ready undelivered Outbox records using PostgreSQL FOR UPDATE SKIP LOCKED,
 * validates event schemas, publishes to Redis within a bounded batch time budget, schedules
 * per-event exponential retry backoff on transient errors, and transitions exhausted or
 * schema-invalid events into the durable Dead Letter Queue (deadLetteredAt).
 */
export async function processOutboxBatch(options: OutboxBatchOptions): Promise<OutboxBatchResult> {
  const {
    db,
    redis,
    channel = OUTBOX_CHANNEL,
    batchSize = DEFAULT_BATCH_SIZE,
    publishTimeoutMs,
    batchTimeBudgetMs,
    transactionTimeoutMs,
    maxAttempts: defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseBackoffMs = 0,
    retryMaxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    now = Date.now,
    quarantinedIds = new Set<string>(),
    tenantIds,
    shouldContinue = () => true,
    metrics = workerMetrics,
  } = options;
  const timing = resolveOutboxTiming({ publishTimeoutMs, batchTimeBudgetMs, transactionTimeoutMs });
  const batchStartNs = process.hrtime.bigint();
  let outcome: 'ok' | 'degraded' | 'budget_exceeded' | 'error' = 'error';

  try {
    const result = await db.$transaction(async tx => {
      const batchDeadlineMs = now() + timing.batchTimeBudgetMs;
      const excluded = [...quarantinedIds].filter(id => UUID_RE.test(id));
      const exclusionSql = excluded.length
        ? Prisma.sql`AND id NOT IN (${Prisma.join(excluded.map(id => Prisma.sql`${id}::uuid`))})`
        : Prisma.empty;
      const scopedTenants = tenantIds?.filter(id => UUID_RE.test(id)) ?? [];
      const tenantScopeSql = scopedTenants.length
        ? Prisma.sql`AND "tenantId" IN (${Prisma.join(scopedTenants.map(id => Prisma.sql`${id}::uuid`))})`
        : Prisma.empty;

      const batch = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
        SELECT id, "tenantId", "storeId", type, "aggregateId", version, "correlationId", "createdAt", attempts, "maxAttempts"
        FROM "Outbox"
        WHERE "deliveredAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "nextAttemptAt" <= now()
        ${tenantScopeSql}
        ${exclusionSql}
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, id ASC
        LIMIT ${batchSize}::int
        FOR UPDATE SKIP LOCKED
      `);

      const deliveredIds: string[] = [];
      const invalidDeadLetterIds: string[] = [];
      const retryUpdates: { id: string; attempts: number; nextAttemptAt: Date; lastError: string }[] = [];
      const deadLetterUpdates: { id: string; attempts: number; lastError: string }[] = [];
      let quarantined = 0;
      let retried = 0;
      let deadLettered = 0;
      let budgetExceeded = false;
      let error: Error | undefined;

      for (const row of batch) {
        if (!shouldContinue()) break;

        const remainingBudgetMs = batchDeadlineMs - now();
        if (remainingBudgetMs <= 0) {
          budgetExceeded = true;
          if (deliveredIds.length === 0 && quarantined === 0 && deadLettered === 0) {
            error = new PublishTimeoutError('batch_budget');
          }
          break;
        }

        const candidate = {
          eventId: row.id,
          schemaVersion: 1 as const,
          tenantId: row.tenantId,
          storeId: row.storeId,
          type: row.type,
          aggregateId: row.aggregateId,
          version: row.version,
          occurredAt: row.createdAt.toISOString(),
        };
        const parsed = eventSchema.safeParse(candidate);
        if (!parsed.success) {
          quarantined++;
          invalidDeadLetterIds.push(row.id);
          quarantineId(quarantinedIds, row.id);
          metrics.recordOutboxQuarantined(quarantinedIds.size, 1);
          workerLogger.ops('error', 'OUTBOX_EVENT_INVALID', {
            component: 'outbox-worker',
            eventId: row.id,
            ...(row.correlationId ? { correlationId: row.correlationId } : {}),
          });
          continue;
        }

        const budgetCapped = remainingBudgetMs < timing.publishTimeoutMs;
        const attemptTimeoutMs = Math.min(timing.publishTimeoutMs, remainingBudgetMs);

        try {
          await publishWithTimeout(
            redis,
            channel,
            JSON.stringify(parsed.data),
            attemptTimeoutMs,
            budgetCapped ? 'batch_budget' : 'publish_timeout',
          );
          deliveredIds.push(row.id);
          metrics.recordOutboxPublished(1);
          workerLogger.ops('info', 'OUTBOX_PUBLISHED', {
            component: 'outbox-worker',
            action: 'outbox.published',
            eventId: row.id,
            eventType: parsed.data.type,
            ...(row.correlationId ? { correlationId: row.correlationId } : {}),
          });
        } catch (err) {
          metrics.recordOutboxFailed(1);
          if (err instanceof PublishTimeoutError && err.reason === 'batch_budget') {
            budgetExceeded = true;
            if (deliveredIds.length === 0 && quarantined === 0 && deadLettered === 0) {
              error = err;
            }
            break;
          }
          const nextAttempts = (row.attempts ?? 0) + 1;
          const maxAllowed = Math.max(1, row.maxAttempts ?? defaultMaxAttempts);
          const errorSummary = sanitizeOutboxError(err);
          const errorType = err instanceof Error ? err.name : typeof err;

          if (nextAttempts >= maxAllowed) {
            deadLettered++;
            deadLetterUpdates.push({ id: row.id, attempts: nextAttempts, lastError: errorSummary });
            quarantineId(quarantinedIds, row.id);
            metrics.recordOutboxDeadLettered(1);
            workerLogger.ops('error', 'OUTBOX_DEAD_LETTERED', {
              component: 'outbox-worker',
              eventId: row.id,
              eventType: parsed.data.type,
              attempts: nextAttempts,
              maxAttempts: maxAllowed,
              errorType,
              ...(row.correlationId ? { correlationId: row.correlationId } : {}),
            });
          } else {
            retried++;
            const delayMs = retryBaseBackoffMs > 0
              ? computeBackoffMs(nextAttempts, retryBaseBackoffMs, retryMaxBackoffMs)
              : 0;
            retryUpdates.push({
              id: row.id,
              attempts: nextAttempts,
              nextAttemptAt: new Date(now() + delayMs),
              lastError: errorSummary,
            });
            workerLogger.ops('warn', 'OUTBOX_EVENT_RETRY_SCHEDULED', {
              component: 'outbox-worker',
              eventId: row.id,
              eventType: parsed.data.type,
              attempts: nextAttempts,
              maxAttempts: maxAllowed,
              retryDelayMs: delayMs,
              errorType,
              ...(row.correlationId ? { correlationId: row.correlationId } : {}),
            });
          }
          error = err instanceof Error ? err : new Error('OUTBOX_PUBLISH_FAILED');
          break;
        }
      }

      if (deliveredIds.length > 0) {
        await tx.outbox.updateMany({
          where: { id: { in: deliveredIds } },
          data: { deliveredAt: new Date() },
        });
      }

      if (typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function') {
        if (invalidDeadLetterIds.length > 0) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "Outbox"
            SET "deadLetteredAt" = now(),
                "lastError" = 'OUTBOX_EVENT_INVALID',
                "attempts" = "attempts" + 1
            WHERE id IN (${Prisma.join(invalidDeadLetterIds.map(id => Prisma.sql`${id}::uuid`))})
              AND "deliveredAt" IS NULL
          `);
        }
        for (const item of deadLetterUpdates) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "Outbox"
            SET "attempts" = ${item.attempts}::int,
                "deadLetteredAt" = now(),
                "lastError" = ${item.lastError}
            WHERE id = ${item.id}::uuid
              AND "deliveredAt" IS NULL
          `);
        }
        for (const item of retryUpdates) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "Outbox"
            SET "attempts" = ${item.attempts}::int,
                "nextAttemptAt" = ${item.nextAttemptAt},
                "lastError" = ${item.lastError}
            WHERE id = ${item.id}::uuid
              AND "deliveredAt" IS NULL
              AND "deadLetteredAt" IS NULL
          `);
        }
      }

      return {
        claimed: batch.length,
        delivered: deliveredIds.length,
        quarantined,
        ...(retried > 0 ? { retried } : {}),
        ...(deadLettered > 0 ? { deadLettered } : {}),
        ...(budgetExceeded ? { budgetExceeded: true } : {}),
        ...(error ? { error } : {}),
      };
    }, { timeout: timing.transactionTimeoutMs });

    outcome = result.budgetExceeded
      ? 'budget_exceeded'
      : result.error
        ? 'degraded'
        : 'ok';
    return result;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      metrics.recordDbError(err.code);
    }
    throw err;
  } finally {
    metrics.recordOutboxBatchDuration(outcome, Number(process.hrtime.bigint() - batchStartNs) / 1e9);
  }
}

export type DeadLetterFilter = {
  tenantId?: string;
  storeId?: string;
  ids?: readonly string[];
  limit?: number;
};

/** Lists dead-lettered outbox events scoped by tenant/store for operator visibility. */
export async function listDeadLetterOutbox(db: PrismaClient, filter: DeadLetterFilter = {}) {
  const limit = Math.min(200, Math.max(1, filter.limit ?? 100));
  return db.outbox.findMany({
    where: {
      deliveredAt: null,
      deadLetteredAt: { not: null },
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(filter.storeId ? { storeId: filter.storeId } : {}),
      ...(filter.ids?.length ? { id: { in: [...filter.ids] } } : {}),
    },
    orderBy: { deadLetteredAt: 'desc' },
    take: limit,
    select: {
      id: true,
      tenantId: true,
      storeId: true,
      type: true,
      aggregateId: true,
      version: true,
      attempts: true,
      maxAttempts: true,
      lastError: true,
      createdAt: true,
      deadLetteredAt: true,
    },
  });
}

/**
 * Safely replays dead-lettered outbox rows back to the pending queue by resetting
 * deadLetteredAt, attempts, nextAttemptAt, and lastError. Never touches delivered rows.
 */
export async function replayDeadLetterOutbox(
  db: PrismaClient,
  options: DeadLetterFilter & { metrics?: MetricsCollector; quarantinedIds?: Set<string> } = {},
): Promise<{ replayed: number; ids: string[] }> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const metrics = options.metrics ?? workerMetrics;
  const result = await db.$transaction(async tx => {
    const candidates = await tx.outbox.findMany({
      where: {
        deliveredAt: null,
        deadLetteredAt: { not: null },
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        ...(options.storeId ? { storeId: options.storeId } : {}),
        ...(options.ids?.length ? { id: { in: [...options.ids] } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    const ids = candidates.map(row => row.id);
    if (ids.length === 0) return { replayed: 0, ids: [] as string[] };
    const updated = await tx.outbox.updateMany({
      where: { id: { in: ids }, deliveredAt: null, deadLetteredAt: { not: null } },
      data: {
        deadLetteredAt: null,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    return { replayed: updated.count, ids };
  });

  if (result.replayed > 0) {
    if (options.quarantinedIds) {
      for (const id of result.ids) options.quarantinedIds.delete(id);
    }
    metrics.recordOutboxReplayed(result.replayed);
    workerLogger.ops('info', 'OUTBOX_DEAD_LETTER_REPLAYED', {
      component: 'outbox-worker',
      replayed: result.replayed,
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.storeId ? { storeId: options.storeId } : {}),
    });
  }
  return result;
}

export type WorkerLoopOptions = {
  db: PrismaClient;
  redis: OutboxPublisher;
  batchSize?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  publishTimeoutMs?: number;
  batchTimeBudgetMs?: number;
  transactionTimeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
  heartbeatFile?: string;
  metrics?: MetricsCollector;
};

/**
 * Supervises outbox polling with exponential failure backoff, Redis/DB heartbeat reporting,
 * Prometheus worker/backlog telemetry, and abortable sleep for deterministic graceful shutdown.
 */
export function createOutboxWorkerLoop(options: WorkerLoopOptions) {
  const {
    db,
    redis,
    batchSize = DEFAULT_BATCH_SIZE,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    publishTimeoutMs,
    batchTimeBudgetMs,
    transactionTimeoutMs,
    maxAttempts,
    now,
    heartbeatFile = process.env.WORKER_HEARTBEAT_FILE,
    metrics = workerMetrics,
  } = options;

  let running = true;
  let degraded = false;
  let consecutiveFailures = 0;
  let inFlight: Promise<void> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeResolve: (() => void) | undefined;
  const quarantinedIds = new Set<string>();
  const hasBacklogReader =
    typeof (db as { outbox?: { count?: unknown; findFirst?: unknown } }).outbox?.count === 'function' &&
    typeof (db as { outbox?: { count?: unknown; findFirst?: unknown } }).outbox?.findFirst === 'function';
  metrics.setOutboxWorkerHealth(true, 0);

  const wait = (ms: number) => new Promise<void>(resolve => {
    if (!running || ms <= 0) {
      resolve();
      return;
    }
    wakeResolve = resolve;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      wakeResolve = undefined;
      resolve();
    }, ms);
  });

  const step = async (): Promise<number> => runWithLogContext(
    {
      correlationId: randomUUID(),
      service: 'omnihub-worker',
      component: 'outbox-worker',
      jobName: 'outbox-batch',
      batchId: randomUUID(),
    },
    async () => {
      try {
        const result = await processOutboxBatch({
          db,
          redis,
          batchSize,
          publishTimeoutMs,
          batchTimeBudgetMs,
          transactionTimeoutMs,
          maxAttempts,
          retryBaseBackoffMs: baseBackoffMs,
          retryMaxBackoffMs: maxBackoffMs,
          now,
          quarantinedIds,
          shouldContinue: () => running,
          metrics,
        });

        if (hasBacklogReader) {
          await metrics.refreshOutboxBacklog(db as unknown as OutboxBacklogReader);
        }

        if (result.error) {
          consecutiveFailures++;
          metrics.setOutboxWorkerHealth(false, consecutiveFailures);
          if (!degraded) {
            workerLogger.ops('warn', 'OUTBOX_RETRY', {
              component: 'outbox-worker',
              errorType: result.error.name,
            });
          }
          degraded = true;
          return computeBackoffMs(consecutiveFailures, baseBackoffMs, maxBackoffMs);
        }

        if (heartbeatFile) {
          if (redis.ping) await redis.ping();
          await writeFile(heartbeatFile, String(Date.now()));
        }

        if (degraded) {
          workerLogger.ops('info', 'OUTBOX_RECOVERED', { component: 'outbox-worker' });
        }
        degraded = false;
        consecutiveFailures = 0;
        metrics.setOutboxWorkerHealth(true, 0);
        const madeProgressUnderBudget =
          Boolean(result.budgetExceeded) && (result.delivered > 0 || result.quarantined > 0);
        return result.claimed >= batchSize || madeProgressUnderBudget ? 0 : pollIntervalMs;
      } catch (err) {
        consecutiveFailures++;
        metrics.setOutboxWorkerHealth(false, consecutiveFailures);
        if (!degraded) {
          workerLogger.ops('warn', 'OUTBOX_RETRY', {
            component: 'outbox-worker',
            errorType: err instanceof Error ? err.name : 'unknown',
          });
        }
        degraded = true;
        return computeBackoffMs(consecutiveFailures, baseBackoffMs, maxBackoffMs);
      }
    },
  );

  const run = async () => {
    while (running) {
      const task = step();
      inFlight = task.then(() => undefined);
      const delayMs = await task;
      inFlight = null;
      if (!running) break;
      await wait(delayMs);
    }
  };

  const stop = async (timeoutMs = 10_000): Promise<void> => {
    running = false;
    metrics.setOutboxWorkerHealth(false, consecutiveFailures);
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }
    if (wakeResolve) {
      wakeResolve();
      wakeResolve = undefined;
    }
    if (inFlight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inFlight,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };

  return { run, step, stop, quarantinedIds };
}
