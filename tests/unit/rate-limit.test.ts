import { describe, expect, it } from 'vitest';
import { createRedisRateLimiter, incrementRateWindow, rateLimitRedisReady, setRateLimitRedisHealthProbe, type RateLimitRedis } from '../../apps/api/src/rate-limit';

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

  it('tracks Redis readiness probes, rejects malformed script results, and sets standard rate headers', async () => {
    setRateLimitRedisHealthProbe(async () => 'ERR');
    expect(await rateLimitRedisReady()).toBe(false);
    setRateLimitRedisHealthProbe(async () => 'PONG');
    expect(await rateLimitRedisReady()).toBe(true);
    await expect(incrementRateWindow({ eval: async () => 'bad' } as unknown as RateLimitRedis, 'k', 60_000)).rejects.toThrow('INVALID_RATE_LIMIT_RESPONSE');
    await expect(incrementRateWindow({ eval: async () => [0, 1000] } as unknown as RateLimitRedis, 'k', 60_000)).rejects.toThrow('INVALID_RATE_LIMIT_RESPONSE');

    const storage = new SharedRedisCounters();
    const limiter = createRedisRateLimiter(storage.client, { prefix: 'api/public', limit: 1, windowMs: 60_000 });
    const makeRes = () => ({
      statusCode: 200,
      body: undefined as unknown,
      headers: new Map<string, string | number>(),
      setHeader(name: string, value: string | number) { this.headers.set(name, value); return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
      getHeader() { return 'corr-1'; },
    });

    const first = makeRes();
    let passed = false;
    await new Promise<void>(resolve => {
      limiter({ socket: {} } as never, first as never, () => { passed = true; resolve(); });
    });
    expect(passed).toBe(true);
    expect(first.headers.get('RateLimit-Limit')).toBe(1);
    expect(first.headers.get('RateLimit-Remaining')).toBe(0);

    const blocked = makeRes();
    await new Promise<void>(resolve => {
      const origJson = blocked.json.bind(blocked);
      blocked.json = (body: unknown) => { origJson(body); resolve(); return blocked; };
      limiter({ socket: {} } as never, blocked as never, () => resolve());
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe(60);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', correlationId: 'corr-1' });
  });
});
