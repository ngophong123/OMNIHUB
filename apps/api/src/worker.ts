import 'dotenv/config';
import Redis from 'ioredis';
import { db } from './database';
import { validateDeployment } from './deployment-security';
import { createOutboxWorkerLoop } from './outbox';

validateDeployment();

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
redis.on('error', () => undefined);

const loop = createOutboxWorkerLoop({ db, redis });
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await loop.stop(10_000);
  await Promise.race([
    redis.quit().catch(() => undefined),
    new Promise<void>(resolve => setTimeout(resolve, 1_000)),
  ]);
  redis.disconnect();
  await db.$disconnect();
  console.log(JSON.stringify({ level: 'info', component: 'outbox-worker', code: 'OUTBOX_STOPPED' }));
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

void loop.run().catch(() => {
  console.error(JSON.stringify({ level: 'error', component: 'outbox-worker', code: 'OUTBOX_WORKER_FAILED' }));
  process.exitCode = 1;
});
