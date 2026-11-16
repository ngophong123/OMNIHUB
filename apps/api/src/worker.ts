import 'dotenv/config';
import express from 'express';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import { db } from './database';
import { validateDeployment } from './deployment-security';
import { createOutboxWorkerLoop } from './outbox';
import { workerLogger } from './observability/logger';
import { workerMetrics } from './observability/metrics';
import { createMetricsRequestHandler } from './observability/metrics-endpoint';

validateDeployment();

let metricsServer: Server | undefined;
const metricsPortRaw = process.env.WORKER_METRICS_PORT;
if (metricsPortRaw) {
  const metricsPort = Number(metricsPortRaw);
  if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) {
    throw new Error('WORKER_METRICS_PORT must be an integer between 1 and 65535');
  }
  const metricsApp = express();
  metricsApp.disable('x-powered-by');
  metricsApp.get('/metrics', createMetricsRequestHandler({ metrics: workerMetrics, backlogDb: db }));
  metricsServer = metricsApp.listen(metricsPort, process.env.WORKER_METRICS_HOST ?? '127.0.0.1');
}

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
    if (metricsServer) {
      await new Promise<void>(resolve => metricsServer?.close(() => resolve()));
    }
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
    workerMetrics.close();
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
  workerMetrics.close();
  await workerLogger.close();
  process.exitCode = 1;
});
