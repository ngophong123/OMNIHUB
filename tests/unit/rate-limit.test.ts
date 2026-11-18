import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLockedException, login } from '../../apps/api/src/auth';
import { hashPassword } from '../../apps/api/src/domain';
import { runWithLogContext } from '../../apps/api/src/observability/request-context';
import {
  accountFailureKey,
  accountLockKey,
  accountRateLimitIdentifier,
  checkAccountLoginLock,
  configuredRateLimit,
  configurePublicAndAuthRateLimits,
  createAuthAccountProtectionMiddleware,
  createRedisRateLimiter,
  DEFAULT_AUTH_LOGIN_IP_LIMIT,
  incrementRateWindow,
  normalizeAccountEmail,
  rateLimitRedisReady,
  recordAccountLoginFailure,
  resetAccountLoginFailures,
  resolveAuthLoginIpLimit,
  setRateLimitRedisHealthProbe,
  type RateLimitRedis,
} from '../../apps/api/src/rate-limit';

class SimulatedLuaRedis {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  readonly commandsUsed: string[] = [];

  readonly client: RateLimitRedis = {
    eval: async (script: string, numKeys: number, ...rest: (string | number)[]) => {
      const keys = rest.slice(0, numKeys).map(String);
      const argv = rest.slice(numKeys).map(String);

      if (script.includes("local ttl = redis.call('PTTL', KEYS[1])") && !script.includes('INCR')) {
        this.commandsUsed.push('PTTL');
        const key = keys[0]!;
        const ttl = this.ttls.get(key) ?? -2;
        return ttl > 0 ? ttl : 0;
      }

      if (script.includes('existingLockTtl')) {
        const failKey = keys[0]!;
        const lockKey = keys[1]!;
        const windowMs = Number(argv[0]);
        const maxFailures = Number(argv[1]);
        this.commandsUsed.push('PTTL');
        const existingLockTtl = this.ttls.get(lockKey) ?? -2;
        if (existingLockTtl > 0) {
          return [maxFailures + 1, existingLockTtl, 1, 0];
        }
        this.commandsUsed.push('INCR');
        const count = (this.values.get(failKey) ?? 0) + 1;
        this.values.set(failKey, count);
        if (count === 1) {
          this.commandsUsed.push('PEXPIRE');
          this.ttls.set(failKey, windowMs);
        }
        this.commandsUsed.push('PTTL');
        let ttl = this.ttls.get(failKey) ?? -1;
        if (ttl <= 0) {
          this.commandsUsed.push('PEXPIRE');
          this.ttls.set(failKey, windowMs);
          ttl = windowMs;
        }
        let locked = 0;
        let newlyLocked = 0;
        if (count >= maxFailures) {
          this.commandsUsed.push('INCR', 'PEXPIRE');
          const lockCount = (this.values.get(lockKey) ?? 0) + 1;
          this.values.set(lockKey, lockCount);
          if (lockCount === 1) newlyLocked = 1;
          this.ttls.set(lockKey, ttl);
          locked = 1;
        }
        return [count, ttl, locked, newlyLocked];
      }

      if (script.includes("redis.call('PEXPIRE', KEYS[1], 0)")) {
        for (const key of keys) {
          this.commandsUsed.push('PTTL');
          if ((this.ttls.get(key) ?? -2) > 0) {
            this.commandsUsed.push('PEXPIRE');
            this.values.delete(key);
            this.ttls.delete(key);
          }
        }
        return 1;
      }

      const key = keys[0]!;
      const windowMs = Number(argv[0] ?? 60_000);
      this.commandsUsed.push('INCR');
      const count = (this.values.get(key) ?? 0) + 1;
      this.values.set(key, count);
      if (count === 1) {
        this.commandsUsed.push('PEXPIRE');
        this.ttls.set(key, windowMs);
      }
      this.commandsUsed.push('PTTL');
      return [count, this.ttls.get(key) ?? windowMs];
    },
  } as unknown as RateLimitRedis;
}

function makeMockResponse(correlationId = 'corr-1') {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string | number>(),
    setHeader(name: string, value: string | number) {
      this.headers.set(name, value);
      return this;
    },
    getHeader(name: string) {
      if (name.toLowerCase() === 'x-correlation-id') return correlationId;
      return this.headers.get(name);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('Redis rate limit counters & dual-key auth protection (M2-T10)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares an atomic window across independent API clients', async () => {
    const storage = new SimulatedLuaRedis();
    const [replicaOne, replicaTwo] = await Promise.all([
      incrementRateWindow(storage.client, 'omnihub:rate:v1:login:client', 60_000),
      incrementRateWindow(storage.client, 'omnihub:rate:v1:login:client', 60_000),
    ]);
    expect([replicaOne.count, replicaTwo.count].sort()).toEqual([1, 2]);
  });

  it('normalizes account emails deterministically across replicas without storing plaintext in Redis keys', () => {
    expect(normalizeAccountEmail('  Cashier.One@Example.COM  ')).toBe('cashier.one@example.com');
    const id1 = accountRateLimitIdentifier('  Cashier.One@Example.COM ');
    const id2 = accountRateLimitIdentifier('cashier.one@example.com');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[a-f0-9]{64}$/);

    const failKey = accountFailureKey('Cashier.One@Example.COM');
    const lockKey = accountLockKey('Cashier.One@Example.COM');
    expect(failKey).toBe(`omnihub:rate:v1:acct-fail:${id1}`);
    expect(lockKey).toBe(`omnihub:rate:v1:acct-lock:${id1}`);
    expect(failKey.toLowerCase()).not.toContain('cashier');
    expect(failKey.toLowerCase()).not.toContain('example.com');
  });

  it('validates AUTH_LOGIN_IP_LIMIT and rate-limit configuration boundaries', () => {
    expect(resolveAuthLoginIpLimit({})).toBe(DEFAULT_AUTH_LOGIN_IP_LIMIT);
    expect(resolveAuthLoginIpLimit({ AUTH_LOGIN_IP_LIMIT: '80', AUTH_LOGIN_RATE_LIMIT: '10' })).toBe(80);
    expect(resolveAuthLoginIpLimit({ AUTH_LOGIN_RATE_LIMIT: '15' })).toBe(15);
    expect(() => resolveAuthLoginIpLimit({ AUTH_LOGIN_IP_LIMIT: '0' })).toThrow('AUTH_LOGIN_IP_LIMIT must be an integer');
    expect(() => configuredRateLimit('PUBLIC_INVITATION_RATE_LIMIT', 10, 200, { PUBLIC_INVITATION_RATE_LIMIT: '201' })).toThrow(
      'PUBLIC_INVITATION_RATE_LIMIT must be an integer from 1 to 200',
    );
  });

  it('fails protected requests closed when the shared store is unavailable', async () => {
    const failingRedis: RateLimitRedis = {
      eval: async () => {
        throw new Error('redis unavailable');
      },
    };
    const limiter = createRedisRateLimiter(failingRedis, { prefix: 'login', limit: 10, windowMs: 60_000 });
    const response = makeMockResponse('test-correlation');
    await new Promise<void>(resolve => {
      const originalJson = response.json.bind(response);
      response.json = (body: unknown) => {
        originalJson(body);
        resolve();
        return response;
      };
      limiter({ ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as never, response as never, () => resolve());
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'RATE_LIMITER_UNAVAILABLE' });

    const passwordHash = hashPassword('CorrectPass123!');
    const fakeDb = {
      user: { findUnique: async () => ({ id: 'u1', active: true, passwordHash }) },
      membership: { findUnique: async () => ({ tenantId: 't1', role: 'OWNER' }) },
      session: { create: async () => undefined },
    } as unknown as PrismaClient;

    // Pre-check Redis failure fails closed with 503
    await expect(
      runWithLogContext({ correlationId: 'corr-503-pre', service: 'omnihub-api' }, () =>
        login(fakeDb, 'owner@test.local', 'CorrectPass123!', 's1', { redis: failingRedis }),
      ),
    ).rejects.toMatchObject({ message: 'RATE_LIMITER_UNAVAILABLE' });

    // Failure-record Redis failure fails closed with 503
    let calls = 0;
    const failOnSecondEval: RateLimitRedis = {
      eval: async () => {
        calls++;
        if (calls === 1) return 0;
        throw new Error('redis write lost');
      },
    };
    await expect(
      login(fakeDb, 'owner@test.local', 'WrongPass123!', 's1', { redis: failOnSecondEval }),
    ).rejects.toMatchObject({ message: 'RATE_LIMITER_UNAVAILABLE' });

    // Reset Redis failure on valid login also fails closed with 503
    let resetCalls = 0;
    const failOnResetEval: RateLimitRedis = {
      eval: async () => {
        resetCalls++;
        if (resetCalls === 1) return 0;
        throw new Error('redis reset lost');
      },
    };
    await expect(
      login(fakeDb, 'owner@test.local', 'CorrectPass123!', 's1', { redis: failOnResetEval }),
    ).rejects.toMatchObject({ message: 'RATE_LIMITER_UNAVAILABLE' });
  });

  it('tracks Redis readiness probes, rejects malformed script results, and sets standard rate headers', async () => {
    setRateLimitRedisHealthProbe(async () => 'ERR');
    expect(await rateLimitRedisReady()).toBe(false);
    setRateLimitRedisHealthProbe(async () => 'PONG');
    expect(await rateLimitRedisReady()).toBe(true);

    await expect(incrementRateWindow({ eval: async () => 'bad' } as unknown as RateLimitRedis, 'k', 60_000)).rejects.toThrow(
      'INVALID_RATE_LIMIT_RESPONSE',
    );
    await expect(incrementRateWindow({ eval: async () => [0, 1000] } as unknown as RateLimitRedis, 'k', 60_000)).rejects.toThrow(
      'INVALID_RATE_LIMIT_RESPONSE',
    );
    await expect(checkAccountLoginLock({ eval: async () => -1 } as unknown as RateLimitRedis, 'a@b.c')).rejects.toThrow(
      'INVALID_RATE_LIMIT_RESPONSE',
    );
    await expect(recordAccountLoginFailure({ eval: async () => [1, 2] } as unknown as RateLimitRedis, 'a@b.c')).rejects.toThrow(
      'INVALID_RATE_LIMIT_RESPONSE',
    );
    await expect(
      recordAccountLoginFailure({ eval: async () => [0, 1000, 0, 0] } as unknown as RateLimitRedis, 'a@b.c'),
    ).rejects.toThrow('INVALID_RATE_LIMIT_RESPONSE');
    await expect(resetAccountLoginFailures({ eval: async () => 0 } as unknown as RateLimitRedis, 'a@b.c')).rejects.toThrow(
      'INVALID_RATE_LIMIT_RESPONSE',
    );

    const storage = new SimulatedLuaRedis();
    const limiter = createRedisRateLimiter(storage.client, { prefix: 'api/public', limit: 1, windowMs: 60_000 });

    const first = makeMockResponse();
    let passed = false;
    await new Promise<void>(resolve => {
      limiter({ socket: {} } as never, first as never, () => {
        passed = true;
        resolve();
      });
    });
    expect(passed).toBe(true);
    expect(first.headers.get('RateLimit-Limit')).toBe(1);
    expect(first.headers.get('RateLimit-Remaining')).toBe(0);

    const blocked = makeMockResponse();
    await new Promise<void>(resolve => {
      const origJson = blocked.json.bind(blocked);
      blocked.json = (body: unknown) => {
        origJson(body);
        resolve();
        return blocked;
      };
      limiter({ socket: {} } as never, blocked as never, () => resolve());
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe(60);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', correlationId: 'corr-1' });
  });

  it('increments account failures on bad password/unknown/inactive user, ignores membership failure, resets on success, and short-circuits locked accounts before scrypt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const storage = new SimulatedLuaRedis();
    const passwordHash = hashPassword('ValidPass123!');
    let dbLookups = 0;

    const fakeDb = {
      user: {
        findUnique: async ({ where: { email } }: { where: { email: string } }) => {
          dbLookups++;
          if (email === 'owner@omnihub.local') return { id: 'u-owner', active: true, passwordHash };
          if (email === 'inactive@omnihub.local') return { id: 'u-inactive', active: false, passwordHash };
          if (email === 'cashier@omnihub.local') return { id: 'u-cashier', active: true, passwordHash };
          return null;
        },
      },
      membership: {
        findUnique: async ({ where: { userId_storeId } }: { where: { userId_storeId: { userId: string; storeId: string } } }) =>
          userId_storeId.storeId === 'store-1' ? { tenantId: 'tenant-1', role: 'OWNER' } : null,
      },
      session: { create: async () => undefined },
    } as unknown as PrismaClient;

    // 1. Unknown email & inactive user increment failure counters and return uniform 401 INVALID_CREDENTIALS
    await expect(
      login(fakeDb, 'unknown@omnihub.local', 'AnyPass123!', 'store-1', { redis: storage.client, limit: 3, windowMs: 900_000 }),
    ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    expect(storage.values.get(accountFailureKey('unknown@omnihub.local'))).toBe(1);

    await expect(
      login(fakeDb, 'inactive@omnihub.local', 'ValidPass123!', 'store-1', { redis: storage.client, limit: 3, windowMs: 900_000 }),
    ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    expect(storage.values.get(accountFailureKey('inactive@omnihub.local'))).toBe(1);

    // 2. Valid password with missing store membership returns 401 without incrementing failed-password counter
    await expect(
      login(fakeDb, 'owner@omnihub.local', 'ValidPass123!', 'other-store', { redis: storage.client, limit: 3, windowMs: 900_000 }),
    ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    expect(storage.values.get(accountFailureKey('owner@omnihub.local'))).toBeUndefined();

    // 3. Two failed attempts followed by successful login resets failure counter via PEXPIRE 0 (never DEL)
    for (let i = 0; i < 2; i++) {
      await expect(
        login(fakeDb, 'Owner@Omnihub.Local', 'WrongPass!', 'store-1', { redis: storage.client, limit: 3, windowMs: 900_000 }),
      ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    }
    expect(storage.values.get(accountFailureKey('owner@omnihub.local'))).toBe(2);

    const session = await login(fakeDb, 'owner@omnihub.local', 'ValidPass123!', 'store-1', {
      redis: storage.client,
      limit: 3,
      windowMs: 900_000,
    });
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.values.get(accountFailureKey('owner@omnihub.local'))).toBeUndefined();
    expect(storage.commandsUsed).not.toContain('DEL');

    // 4. Reaching failure limit (3) locks account with 429 ACCOUNT_LOCKED_RETRY_LATER + Retry-After header via middleware
    const res = makeMockResponse('corr-lock');
    const mw = createAuthAccountProtectionMiddleware(storage.client, { limit: 3, windowMs: 900_000 });

    const runProtectedLogin = (email: string, pass: string) =>
      new Promise<unknown>((resolve, reject) => {
        mw({} as never, res as never, () => {
          runWithLogContext({ correlationId: 'corr-lock', service: 'omnihub-api' }, () => {
            login(fakeDb, email, pass, 'store-1').then(resolve, reject);
          });
        });
      });

    await expect(runProtectedLogin('owner@omnihub.local', 'Wrong1!')).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    await expect(runProtectedLogin('owner@omnihub.local', 'Wrong2!')).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });

    let lockErr: unknown;
    try {
      await runProtectedLogin('owner@omnihub.local', 'Wrong3!');
    } catch (err) {
      lockErr = err;
    }
    expect(lockErr).toBeInstanceOf(AccountLockedException);
    expect((lockErr as AccountLockedException).getStatus()).toBe(429);
    expect((lockErr as AccountLockedException).message).toBe('ACCOUNT_LOCKED_RETRY_LATER');
    expect(res.headers.get('Retry-After')).toBe(900);

    // 5. Subsequent attempts while locked short-circuit BEFORE db.user.findUnique / verifyPassword and do not spam AUTH_ACCOUNT_LOCKED
    const lookupsBeforeBlockedAttempt = dbLookups;
    const lockedLogCountBefore = warnSpy.mock.calls.filter(call => String(call[0]).includes('AUTH_ACCOUNT_LOCKED')).length;
    expect(lockedLogCountBefore).toBe(1);

    await expect(runProtectedLogin('owner@omnihub.local', 'ValidPass123!')).rejects.toMatchObject({
      message: 'ACCOUNT_LOCKED_RETRY_LATER',
    });
    expect(dbLookups).toBe(lookupsBeforeBlockedAttempt);
    const lockedLogCountAfter = warnSpy.mock.calls.filter(call => String(call[0]).includes('AUTH_ACCOUNT_LOCKED')).length;
    expect(lockedLogCountAfter).toBe(1);

    // 6. Another employee (cashier@omnihub.local) on the same NAT IP is completely unaffected by owner's account lock
    const cashierSession = await runProtectedLogin('cashier@omnihub.local', 'ValidPass123!');
    expect(cashierSession).toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/) });

    // 7. No raw email or password ever appears in security logs
    const serializedLogs = JSON.stringify(warnSpy.mock.calls);
    expect(serializedLogs).not.toContain('owner@omnihub.local');
    expect(serializedLogs).not.toContain('Wrong1!');
    expect(serializedLogs).not.toContain('ValidPass123!');
  });

  it('enforces a dedicated 10 req/min limit on /public/invitations/ without being overwritten by /public/', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new SimulatedLuaRedis();
    const routes: Array<{ path: string; handler: ReturnType<typeof createRedisRateLimiter> }> = [];
    configurePublicAndAuthRateLimits(
      {
        use(path, handler) {
          routes.push({ path, handler });
        },
      },
      storage.client,
      { PUBLIC_INVITATION_RATE_LIMIT: '2', PUBLIC_API_RATE_LIMIT: '60', AUTH_LOGIN_IP_LIMIT: '60' },
    );

    const runPipeline = async (urlPath: string, ip: string) => {
      const req = { ip, socket: { remoteAddress: ip } } as Record<string, unknown>;
      const res = makeMockResponse();
      const matching = routes.filter(r => urlPath.startsWith(r.path));
      let idx = 0;
      await new Promise<void>(resolve => {
        const next = () => {
          const current = matching[idx++];
          if (!current) {
            resolve();
            return;
          }
          const origJson = res.json.bind(res);
          res.json = (body: unknown) => {
            origJson(body);
            resolve();
            return res;
          };
          current.handler(req as never, res as never, next);
        };
        next();
      });
      return res;
    };

    const r1 = await runPipeline('/public/invitations/token-1/accept', '198.51.100.10');
    const r2 = await runPipeline('/public/invitations/token-1/accept', '198.51.100.10');
    const r3 = await runPipeline('/public/invitations/token-1/accept', '198.51.100.10');

    // Specific invitation limit (2) is preserved and not overwritten by generic /public/ (60)
    expect(r1.statusCode).toBe(200);
    expect(r1.headers.get('RateLimit-Limit')).toBe(2);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers.get('RateLimit-Limit')).toBe(2);
    expect(r3.statusCode).toBe(429);
    expect(r3.headers.get('Retry-After')).toBe(60);
    expect(r3.body).toMatchObject({ code: 'RATE_LIMITED' });

    // Other /public/ routes on the same IP still use the separate 60 req/min public bucket
    const qrRes = await runPipeline('/public/qr/token/menu', '198.51.100.10');
    expect(qrRes.statusCode).toBe(200);
    expect(qrRes.headers.get('RateLimit-Limit')).toBe(60);
  });
});
