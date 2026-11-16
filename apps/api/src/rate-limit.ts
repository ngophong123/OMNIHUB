import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type Redis from 'ioredis';
import { digest } from './domain';
import { apiLogger } from './observability/logger';
import { apiMetrics } from './observability/metrics';

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export type RateDecision = { count: number; ttlMs: number };
export type RateLimitRedis = Pick<Redis, 'eval'>;
let redisHealthProbe: (() => Promise<string>) | undefined;

export function setRateLimitRedisHealthProbe(probe: () => Promise<string>): void { redisHealthProbe = probe; }
export async function rateLimitRedisReady(): Promise<boolean> { return !!redisHealthProbe && await redisHealthProbe() === 'PONG'; }

export async function incrementRateWindow(redis: RateLimitRedis, key: string, windowMs: number): Promise<RateDecision> {
  const result = await redis.eval(incrementScript, 1, key, String(windowMs));
  if (!Array.isArray(result) || result.length !== 2) throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  const count = Number(result[0]);
  const ttlMs = Number(result[1]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error('INVALID_RATE_LIMIT_RESPONSE');
  return { count, ttlMs };
}

export function createRedisRateLimiter(redis: RateLimitRedis, options: { prefix: string; limit: number; windowMs: number }): RequestHandler {
  const prefix = options.prefix.replace(/[^a-zA-Z0-9:_-]/g, '_');
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 1;
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  return (req: Request, res: Response, next: NextFunction) => {
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `omnihub:rate:v1:${prefix}:${digest(address)}`;
    void incrementRateWindow(redis, key, windowMs).then(({ count, ttlMs }) => {
      const remaining = Math.max(0, limit - count);
      const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', resetSeconds);
      if (count > limit) {
        res.setHeader('Retry-After', resetSeconds);
        const correlationId = res.getHeader('x-correlation-id');
        apiMetrics.recordRateLimitDecision(prefix, 'blocked_429');
        apiLogger.security('warn', 'RATE_LIMITED', { component: 'rate-limiter', prefix, remaining: 0, resetSeconds, ...(correlationId ? { correlationId } : {}) });
        res.status(429).json({ code: 'RATE_LIMITED', correlationId });
        return;
      }
      apiMetrics.recordRateLimitDecision(prefix, 'allowed');
      next();
    }).catch((error: unknown) => {
      // Protected routes fail closed: a Redis outage cannot reset counters on each API replica.
      const correlationId = res.getHeader('x-correlation-id');
      apiMetrics.recordRateLimitDecision(prefix, 'unavailable_503');
      apiLogger.ops('error', 'RATE_LIMITER_UNAVAILABLE', {
        component: 'rate-limiter',
        prefix,
        errorType: error instanceof Error ? error.name : typeof error,
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(503).json({ code: 'RATE_LIMITER_UNAVAILABLE', correlationId });
    });
  };
}
