import { describe, expect, it } from 'vitest';
import { createRedisRateLimiter, incrementRateWindow, type RateLimitRedis } from '../../apps/api/src/rate-limit';

class SharedRedisCounters {
  readonly values = new Map<string, number>();
  readonly client: RateLimitRedis = {
    eval: async (_script: string, _numKeys: number, key: string) => {
      const count = (this.values.get(key) ?? 0) + 1;
      this.values.set(key, count);
      return [count, 60_000];
    },
  } as unknown as RateLimitRedis;
}

describe('Redis rate limit counters', () => {
  it('shares an atomic window across independent API clients', async () => {
    const storage = new SharedRedisCounters();
    const [replicaOne, replicaTwo] = await Promise.all([
      incrementRateWindow(storage.client, 'omnihub:rate:v1:login:client', 60_000),
      incrementRateWindow(storage.client, 'omnihub:rate:v1:login:client', 60_000),
    ]);
    expect([replicaOne.count, replicaTwo.count].sort()).toEqual([1, 2]);
  });

  it('fails protected requests closed when the shared store is unavailable', async () => {
    const limiter = createRedisRateLimiter({ eval: async () => { throw new Error('redis unavailable'); } }, { prefix: 'login', limit: 10, windowMs: 60_000 });
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      headers: new Map<string, string | number>(),
      setHeader(name: string, value: string | number) { this.headers.set(name, value); return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
      getHeader() { return 'test-correlation'; },
    };
    await new Promise<void>(resolve => {
      const originalJson = response.json.bind(response);
      response.json = (body: unknown) => { originalJson(body); resolve(); return response; };
      limiter({ ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as never, response as never, () => resolve());
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITER_UNAVAILABLE' });
  });
});
