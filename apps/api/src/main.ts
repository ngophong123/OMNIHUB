import 'reflect-metadata';
import 'dotenv/config';
import Redis from 'ioredis';
import { db } from './database';
import { attachRealtime } from './realtime';
import { createRedisRateLimiter, setRateLimitRedisHealthProbe } from './rate-limit';
import { validateDeployment } from './deployment-security';
import { createConfiguredHttpApp } from './http-app';
import { apiLogger } from './observability/logger';

function configuredLimit(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}

async function main() {
  validateDeployment();
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const trustedProxies = process.env.TRUSTED_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean);
  const limiterRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  let limiterRedisConnected = false;
  let limiterRedisFailed = false;
  limiterRedis.on('ready', () => {
    if (!limiterRedisConnected) apiLogger.ops('info', 'REDIS_READY', { component: 'rate-limiter' });
    limiterRedisConnected = true;
  });
  limiterRedis.on('error', error => {
    if (limiterRedisConnected || !limiterRedisFailed) apiLogger.ops('warn', 'REDIS_UNAVAILABLE', { component: 'rate-limiter', errorType: error.name });
    limiterRedisConnected = false;
    limiterRedisFailed = true;
  });
  setRateLimitRedisHealthProbe(() => limiterRedis.ping());
  const windowMs = configuredLimit('RATE_LIMIT_WINDOW_SECONDS', 60, 3600) * 1000;
  const app = await createConfiguredHttpApp({
    origin,
    trustedProxies,
    configureBeforeFilters: configuredApp => {
      configuredApp.use('/auth/login', createRedisRateLimiter(limiterRedis, { prefix: 'login', limit: configuredLimit('AUTH_LOGIN_RATE_LIMIT', 10, 100), windowMs }));
      configuredApp.use('/public/table-sessions/orders', createRedisRateLimiter(limiterRedis, { prefix: 'qr-order', limit: configuredLimit('QR_ORDER_RATE_LIMIT', 20, 200), windowMs }));
      configuredApp.use('/public/', createRedisRateLimiter(limiterRedis, { prefix: 'public', limit: configuredLimit('PUBLIC_API_RATE_LIMIT', 60, 1000), windowMs }));
      configuredApp.use('/webhooks/', createRedisRateLimiter(limiterRedis, { prefix: 'webhook', limit: configuredLimit('WEBHOOK_RATE_LIMIT', 120, 5000), windowMs }));
    },
  });
  await app.listen(Number(process.env.PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
  apiLogger.ops('info', 'API_LISTENING', { component: 'bootstrap' });
  const closeRealtime = attachRealtime(app.getHttpServer(), origin);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return; stopping = true;
    // One owner for signal handling; Nest's additional handler used to race DB
    // disconnection with active HTTP transactions. app.close drains HTTP first.
    const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
    void closeRealtime().then(() => app.close()).then(() => limiterRedis.quit().catch(() => limiterRedis.disconnect())).then(() => db.$disconnect())
      .then(async () => {
        apiLogger.ops('info', 'API_STOPPED', { component: 'bootstrap', signal });
        await apiLogger.close();
        clearTimeout(deadline);
      })
      .catch(async (err: unknown) => {
        apiLogger.ops('error', 'API_SHUTDOWN_FAILED', { component: 'bootstrap', signal, errorType: err instanceof Error ? err.name : typeof err });
        await apiLogger.close();
        clearTimeout(deadline);
        process.exitCode = 1;
      });
  });
}
void main().catch(async (err: unknown) => {
  apiLogger.ops('fatal', 'API_START_FAILED', { component: 'bootstrap', errorType: err instanceof Error ? err.name : typeof err });
  await apiLogger.close();
  process.exitCode = 1;
});
