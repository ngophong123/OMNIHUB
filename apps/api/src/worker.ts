import 'dotenv/config';
import Redis from 'ioredis';
import { db } from './database';
import { validateDeployment } from './deployment-security';
import { createOutboxWorkerLoop } from './outbox';
import { workerLogger } from './observability/logger';

validateDeployment();

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
let redisConnected = false;
let redisFailed = false;
redis.on('ready', () => {
  if (!redisConnected) workerLogger.ops('info', 'OUTBOX_REDIS_READY', { component: 'outbox-worker' });
  redisConnected = true;
});
redis.on('error', error => {
  if (redisConnected || !redisFailed) {
    workerLogger.ops('warn', 'OUTBOX_REDIS_UNAVAILABLE', { component: 'outbox-worker', errorType: error.name });
  }
  redisConnected = false;
  redisFailed = true;
});

const loop = createOutboxWorkerLoop({ db, redis });
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await loop.stop(10_000);
    await Promise.race([
      redis.quit().catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 1_000)),
    ]);
    redis.disconnect();
    await db.$disconnect();
    workerLogger.ops('info', 'OUTBOX_STOPPED', { component: 'outbox-worker' });
  } catch (err: unknown) {
    workerLogger.ops('error', 'OUTBOX_SHUTDOWN_FAILED', {
      component: 'outbox-worker',
      errorType: err instanceof Error ? err.name : typeof err,
    });
    process.exitCode = 1;
  } finally {
    await workerLogger.close();
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

void loop.run().catch(async (err: unknown) => {
  workerLogger.ops('fatal', 'OUTBOX_WORKER_FAILED', {
    component: 'outbox-worker',
    errorType: err instanceof Error ? err.name : typeof err,
  });
  await workerLogger.close();
  process.exitCode = 1;
});
