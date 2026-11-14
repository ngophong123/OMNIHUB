import 'dotenv/config';
import Redis from '../../apps/api/node_modules/ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisRateLimiter, incrementRateWindow } from '../../apps/api/src/rate-limit';
import { digest } from '../../apps/api/src/domain';

const url = process.env.REDIS_URL;
const first = url ? new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null }) : undefined;
const second = url ? new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null }) : undefined;
first?.on('error', () => undefined); second?.on('error', () => undefined);
afterAll(async () => { await Promise.all([first?.quit().catch(() => first.disconnect()), second?.quit().catch(() => second.disconnect())]); });

describe('shared Redis rate limiting', () => {
  it('atomically shares counters across independent API clients', async () => {
    if (!first || !second) throw new Error('REDIS_URL is required for the Redis integration test');
    try { await Promise.all([first.connect(), second.connect()]); } catch { throw new Error('REDIS_UNAVAILABLE: shared counter verification requires the configured Redis endpoint'); }
    expect(await first.ping()).toBe('PONG');
    const key = `omnihub:rate:integration:${crypto.randomUUID()}`;
    const prefix = `replica-${crypto.randomUUID()}`;
    const middlewareKey = `omnihub:rate:v1:${prefix}:${digest('192.0.2.123')}`;
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => incrementRateWindow(index % 2 ? first : second, key, 60_000)));
      expect(results.map(result => result.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(results.every(result => result.ttlMs > 0 && result.ttlMs <= 60_000)).toBe(true);
      const limits = await Promise.all([first, second, first].map(redis => new Promise<number>(resolve => {
        const limiter = createRedisRateLimiter(redis, { prefix, limit: 2, windowMs: 60_000 });
        const response = { statusCode: 200, setHeader() { return this; }, status(code: number) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); return this; }, getHeader() { return 'integration'; } };
        limiter({ ip: '192.0.2.123', socket: { remoteAddress: '192.0.2.123' } } as never, response as never, () => resolve(204));
      })));
      // Independent TCP connections can win the last slot in either order.
      expect(limits.sort((a, b) => a - b)).toEqual([204, 204, 429]);
      // The production ACL intentionally denies DEL. These unique test keys
      // expire after the configured 60-second window.
      expect(await first.pttl(middlewareKey)).toBeGreaterThan(0);
  });
});
