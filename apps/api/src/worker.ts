import 'dotenv/config';
import Redis from 'ioredis';
import { db } from './database';
import { writeFile } from 'node:fs/promises';
import { validateDeployment } from './deployment-security';

validateDeployment();

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
redis.on('error', () => undefined);
let running = true;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { running = false; });
async function work() {
  let degraded = false;
  while (running) {
    try {
      const batch = await db.outbox.findMany({ where: { deliveredAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
      for (const e of batch) {
        if (!running) break;
        await redis.publish('omnihub.events', JSON.stringify({ eventId: e.id, schemaVersion: 1, tenantId: e.tenantId, storeId: e.storeId, type: e.type, aggregateId: e.aggregateId, version: e.version, occurredAt: e.createdAt.toISOString() }));
        await db.outbox.update({ where: { id: e.id }, data: { deliveredAt: new Date() } });
        console.log(JSON.stringify({ level: 'info', action: 'outbox.published', eventId: e.id, correlationId: e.correlationId }));
      }
      if (degraded) console.log(JSON.stringify({ level: 'info', component: 'outbox-worker', code: 'OUTBOX_RECOVERED' }));
      degraded = false;
      if (process.env.WORKER_HEARTBEAT_FILE) {
        await redis.ping();
        await writeFile(process.env.WORKER_HEARTBEAT_FILE, String(Date.now()));
      }
    } catch {
      if (!degraded) console.warn(JSON.stringify({ level: 'warn', component: 'outbox-worker', code: 'OUTBOX_RETRY' }));
      degraded = true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  redis.disconnect(); await db.$disconnect();
}
void work();
