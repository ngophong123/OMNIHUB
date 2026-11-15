import { writeFile } from 'node:fs/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import { eventSchema } from '@omnihub/contracts';

export const OUTBOX_CHANNEL = 'omnihub.events';
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
export const DEFAULT_BATCH_TIME_BUDGET_MS = 10_000;
export const DEFAULT_TX_COMMIT_HEADROOM_MS = 5_000;
export const DEFAULT_TX_TIMEOUT_MS = 15_000;
export const DEFAULT_BASE_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
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
  now?: () => number;
  quarantinedIds?: Set<string>;
  tenantIds?: readonly string[];
  shouldContinue?: () => boolean;
};

export type OutboxBatchResult = {
  claimed: number;
  delivered: number;
  quarantined: number;
  budgetExceeded?: boolean;
  error?: Error;
};

class PublishTimeoutError extends Error {
  constructor(public readonly reason: 'publish_timeout' | 'batch_budget') {
    super(reason === 'batch_budget' ? 'OUTBOX_BATCH_BUDGET_EXCEEDED' : 'OUTBOX_PUBLISH_TIMEOUT');
    this.name = 'PublishTimeoutError';
  }
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

/** Computes bounded exponential backoff with jitter across consecutive transient worker failures. */
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
 * Atomically claims undelivered Outbox records using PostgreSQL FOR UPDATE SKIP LOCKED,
 * validates event schemas, publishes to Redis within a bounded batch time budget, and
 * commits delivered rows before the Prisma transaction deadline so unprocessed events
 * remain pending for subsequent batches under at-least-once delivery semantics.
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
    now = Date.now,
    quarantinedIds = new Set<string>(),
    tenantIds,
    shouldContinue = () => true,
  } = options;
  const timing = resolveOutboxTiming({ publishTimeoutMs, batchTimeBudgetMs, transactionTimeoutMs });

  return db.$transaction(async tx => {
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
      SELECT id, "tenantId", "storeId", type, "aggregateId", version, "correlationId", "createdAt"
      FROM "Outbox"
      WHERE "deliveredAt" IS NULL
      ${tenantScopeSql}
      ${exclusionSql}
      ORDER BY "createdAt" ASC, id ASC
      LIMIT ${batchSize}::int
      FOR UPDATE SKIP LOCKED
    `);

    const deliveredIds: string[] = [];
    let quarantined = 0;
    let budgetExceeded = false;
    let error: Error | undefined;

    for (const row of batch) {
      if (!shouldContinue()) break;

      const remainingBudgetMs = batchDeadlineMs - now();
      if (remainingBudgetMs <= 0) {
        budgetExceeded = true;
        if (deliveredIds.length === 0 && quarantined === 0) {
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
        quarantineId(quarantinedIds, row.id);
        console.error(JSON.stringify({
          level: 'error',
          component: 'outbox-worker',
          code: 'OUTBOX_EVENT_INVALID',
          eventId: row.id,
          correlationId: row.correlationId,
        }));
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
        console.log(JSON.stringify({
          level: 'info',
          action: 'outbox.published',
          eventId: row.id,
          correlationId: row.correlationId,
        }));
      } catch (err) {
        if (err instanceof PublishTimeoutError && err.reason === 'batch_budget') {
          budgetExceeded = true;
          if (deliveredIds.length === 0 && quarantined === 0) {
            error = err;
          }
          break;
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

    return {
      claimed: batch.length,
      delivered: deliveredIds.length,
      quarantined,
      ...(budgetExceeded ? { budgetExceeded: true } : {}),
      ...(error ? { error } : {}),
    };
  }, { timeout: timing.transactionTimeoutMs });
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
  now?: () => number;
  heartbeatFile?: string;
};

/**
 * Supervises outbox polling with exponential failure backoff, Redis/DB heartbeat reporting,
 * and abortable sleep for deterministic graceful shutdown.
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
    now,
    heartbeatFile = process.env.WORKER_HEARTBEAT_FILE,
  } = options;

  let running = true;
  let degraded = false;
  let consecutiveFailures = 0;
  let inFlight: Promise<void> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeResolve: (() => void) | undefined;
  const quarantinedIds = new Set<string>();

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

  const step = async (): Promise<number> => {
    try {
      const result = await processOutboxBatch({
        db,
        redis,
        batchSize,
        publishTimeoutMs,
        batchTimeBudgetMs,
        transactionTimeoutMs,
        now,
        quarantinedIds,
        shouldContinue: () => running,
      });

      if (result.error) {
        consecutiveFailures++;
        if (!degraded) {
          console.warn(JSON.stringify({
            level: 'warn',
            component: 'outbox-worker',
            code: 'OUTBOX_RETRY',
            errorType: result.error.name,
          }));
        }
        degraded = true;
        return computeBackoffMs(consecutiveFailures, baseBackoffMs, maxBackoffMs);
      }

      if (heartbeatFile) {
        if (redis.ping) await redis.ping();
        await writeFile(heartbeatFile, String(Date.now()));
      }

      if (degraded) {
        console.log(JSON.stringify({ level: 'info', component: 'outbox-worker', code: 'OUTBOX_RECOVERED' }));
      }
      degraded = false;
      consecutiveFailures = 0;
      const madeProgressUnderBudget =
        Boolean(result.budgetExceeded) && (result.delivered > 0 || result.quarantined > 0);
      return result.claimed >= batchSize || madeProgressUnderBudget ? 0 : pollIntervalMs;
    } catch (err) {
      consecutiveFailures++;
      if (!degraded) {
        console.warn(JSON.stringify({
          level: 'warn',
          component: 'outbox-worker',
          code: 'OUTBOX_RETRY',
          errorType: err instanceof Error ? err.name : 'unknown',
        }));
      }
      degraded = true;
      return computeBackoffMs(consecutiveFailures, baseBackoffMs, maxBackoffMs);
    }
  };

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
