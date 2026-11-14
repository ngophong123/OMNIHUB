import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { AppModule, Errors } from './http';
import { db } from './database';
import { attachRealtime } from './realtime';
import { createRedisRateLimiter, setRateLimitRedisHealthProbe } from './rate-limit';
import { accessLogPath, validateDeployment } from './deployment-security';

function configuredLimit(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}

async function main() {
  validateDeployment();
  // Operational request/error records below are JSON. The framework's default
  // startup logger writes unstructured route listings and is disabled in prod.
  const app = await NestFactory.create(AppModule, { logger: process.env.NODE_ENV === 'production' ? false : undefined });
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const trustedProxies = process.env.TRUSTED_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean);
  if (trustedProxies?.length) app.getHttpAdapter().getInstance().set('trust proxy', trustedProxies);
  app.use(helmet()); app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('Cache-Control', 'no-store');
    const start = Date.now();
    res.on('finish', () => {
      const path = accessLogPath(req.originalUrl);
      console.log(JSON.stringify({ level: 'info', method: req.method, path, status: res.statusCode, durationMs: Date.now() - start, correlationId }));
    });
    if ((req.get('origin') && req.get('origin') !== origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin)) { res.status(403).json({ code: 'ORIGIN_DENIED', correlationId }); return; }
    next();
  });
  app.enableCors({ origin, credentials: true, allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Authorization', 'X-Kitchen-Device'] });
  const limiterRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  let limiterRedisConnected = false;
  let limiterRedisFailed = false;
  limiterRedis.on('ready', () => {
    if (!limiterRedisConnected) console.log(JSON.stringify({ level: 'info', component: 'rate-limiter', code: 'REDIS_READY' }));
    limiterRedisConnected = true;
  });
  limiterRedis.on('error', error => {
    if (limiterRedisConnected || !limiterRedisFailed) console.warn(JSON.stringify({ level: 'warn', component: 'rate-limiter', code: 'REDIS_UNAVAILABLE', errorType: error.name }));
    limiterRedisConnected = false;
    limiterRedisFailed = true;
  });
  setRateLimitRedisHealthProbe(() => limiterRedis.ping());
  const windowMs = configuredLimit('RATE_LIMIT_WINDOW_SECONDS', 60, 3600) * 1000;
  app.use('/auth/login', createRedisRateLimiter(limiterRedis, { prefix: 'login', limit: configuredLimit('AUTH_LOGIN_RATE_LIMIT', 10, 100), windowMs }));
  app.use('/public/table-sessions/orders', createRedisRateLimiter(limiterRedis, { prefix: 'qr-order', limit: configuredLimit('QR_ORDER_RATE_LIMIT', 20, 200), windowMs }));
  app.use('/public/', createRedisRateLimiter(limiterRedis, { prefix: 'public', limit: configuredLimit('PUBLIC_API_RATE_LIMIT', 60, 1000), windowMs }));
  app.use('/webhooks/', createRedisRateLimiter(limiterRedis, { prefix: 'webhook', limit: configuredLimit('WEBHOOK_RATE_LIMIT', 120, 5000), windowMs }));
  app.useGlobalFilters(new Errors());
  await app.listen(Number(process.env.PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ level: 'info', code: 'API_LISTENING' }));
  const closeRealtime = attachRealtime(app.getHttpServer(), origin);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return; stopping = true;
    // One owner for signal handling; Nest's additional handler used to race DB
    // disconnection with active HTTP transactions. app.close drains HTTP first.
    const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
    void closeRealtime().then(() => app.close()).then(() => limiterRedis.quit().catch(() => limiterRedis.disconnect())).then(() => db.$disconnect())
      .then(() => { clearTimeout(deadline); console.log(JSON.stringify({ level: 'info', code: 'API_STOPPED' })); })
      .catch(() => { console.error(JSON.stringify({ level: 'error', code: 'API_SHUTDOWN_FAILED' })); process.exitCode = 1; });
  });
}
void main().catch(() => { console.error(JSON.stringify({ level: 'error', code: 'API_START_FAILED' })); process.exitCode = 1; });
