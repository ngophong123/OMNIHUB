import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import Redis from '../../apps/api/node_modules/ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { AccountLockedException, login } from '../../apps/api/src/auth';
import { digest, hashPassword } from '../../apps/api/src/domain';
import {
  accountFailureKey,
  accountLockKey,
  checkAccountLoginLock,
  configurePublicAndAuthRateLimits,
  createRedisRateLimiter,
  incrementRateWindow,
  recordAccountLoginFailure,
  resetAccountLoginFailures,
} from '../../apps/api/src/rate-limit';

const url = process.env.REDIS_URL;
const first = url
  ? new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null })
  : undefined;
const second = url
  ? new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null })
  : undefined;
first?.on('error', () => undefined);
second?.on('error', () => undefined);

afterAll(async () => {
  await Promise.all([
    first?.quit().catch(() => first.disconnect()),
    second?.quit().catch(() => second.disconnect()),
  ]);
});

async function ensureConnected(): Promise<{ first: Redis; second: Redis }> {
  if (!first || !second) throw new Error('REDIS_URL is required for the Redis integration test');
  if (first.status !== 'ready' || second.status !== 'ready') {
    try {
      await Promise.all([
        first.status === 'ready' ? Promise.resolve() : first.connect(),
        second.status === 'ready' ? Promise.resolve() : second.connect(),
      ]);
    } catch {
      throw new Error('REDIS_UNAVAILABLE: shared counter verification requires the configured Redis endpoint');
    }
  }
  expect(await first.ping()).toBe('PONG');
  return { first, second };
}

function createFakeAuthDb(users: Record<string, { id: string; passwordHash: string; active: boolean; storeId: string }>): PrismaClient {
  return {
    user: {
      findUnique: async ({ where: { email } }: { where: { email: string } }) => {
        const entry = users[email];
        return entry ? { id: entry.id, passwordHash: entry.passwordHash, active: entry.active } : null;
      },
    },
    membership: {
      findUnique: async ({ where: { userId_storeId } }: { where: { userId_storeId: { userId: string; storeId: string } } }) => {
        const entry = Object.values(users).find(u => u.id === userId_storeId.userId);
        return entry && entry.storeId === userId_storeId.storeId ? { tenantId: 'tenant-1', role: 'OWNER' } : null;
      },
    },
    session: {
      create: async () => undefined,
    },
  } as unknown as PrismaClient;
}

describe('shared Redis rate limiting & dual-key auth protection (M2-T10)', () => {
  it('atomically shares counters across independent API clients', async () => {
    const { first: r1, second: r2 } = await ensureConnected();
    const key = `omnihub:rate:integration:${randomUUID()}`;
    const prefix = `replica-${randomUUID()}`;
    const middlewareKey = `omnihub:rate:v1:${prefix}:${digest('192.0.2.123')}`;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => incrementRateWindow(index % 2 ? r1 : r2, key, 60_000)),
    );
    expect(results.map(result => result.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(results.every(result => result.ttlMs > 0 && result.ttlMs <= 60_000)).toBe(true);
    const limits = await Promise.all(
      [r1, r2, r1].map(
        redis =>
          new Promise<number>(resolve => {
            const limiter = createRedisRateLimiter(redis, { prefix, limit: 2, windowMs: 60_000 });
            const response = {
              statusCode: 200,
              setHeader() {
                return this;
              },
              status(code: number) {
                this.statusCode = code;
                return this;
              },
              json() {
                resolve(this.statusCode);
                return this;
              },
              getHeader() {
                return 'integration';
              },
            };
            limiter({ ip: '192.0.2.123', socket: { remoteAddress: '192.0.2.123' } } as never, response as never, () =>
              resolve(204),
            );
          }),
      ),
    );
    expect(limits.sort((a, b) => a - b)).toEqual([204, 204, 429]);
    expect(await r1.pttl(middlewareKey)).toBeGreaterThan(0);
  });

  it('blocks distributed brute-force attacks across 20 IPs and 2 Redis clients after 10 failures', async () => {
    const { first: r1, second: r2 } = await ensureConnected();
    const targetEmail = `target-${randomUUID()}@omnihub.test`;
    const passwordHash = hashPassword('StrongOwnerSecret123!');
    const db = createFakeAuthDb({
      [targetEmail]: { id: randomUUID(), passwordHash, active: true, storeId: 'store-1' },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const clientRedis = i % 2 === 0 ? r1 : r2;
      const ip = `198.51.100.${i + 1}`;
      // Each distinct IP passes the IP limiter (1/60), then hits login() account protection.
      const ipDecision = await incrementRateWindow(clientRedis, `omnihub:rate:v1:login:${digest(`${randomUUID()}:${ip}`)}`, 60_000);
      expect(ipDecision.count).toBe(1);

      try {
        await login(db, targetEmail, `WrongAttempt-${i}`, 'store-1', {
          redis: clientRedis,
          limit: 10,
          windowMs: 60_000,
        });
        statuses.push(200);
      } catch (err) {
        if (err instanceof AccountLockedException) {
          expect(err.retryAfterSeconds).toBeGreaterThan(0);
          expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
          statuses.push(err.getStatus());
        } else {
          statuses.push((err as { getStatus?: () => number }).getStatus?.() ?? 500);
        }
      }
    }

    // Attempts 1..9 return 401 INVALID_CREDENTIALS; attempts 10..20 across all remaining IPs return 429 ACCOUNT_LOCKED_RETRY_LATER.
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(statuses.slice(9)).toEqual(Array(11).fill(429));

    // Even supplying the correct password from a new 21st IP while locked is rejected with 429.
    await expect(
      login(db, targetEmail, 'StrongOwnerSecret123!', 'store-1', { redis: r2, limit: 10, windowMs: 60_000 }),
    ).rejects.toMatchObject({ message: 'ACCOUNT_LOCKED_RETRY_LATER' });
  }, 30_000);

  it('preserves NAT isolation so locking one account does not block other staff sharing the same WAN IP', async () => {
    const { first: r1, second: r2 } = await ensureConnected();
    const natIpKey = `omnihub:rate:v1:login:${digest(`nat-${randomUUID()}`)}`;
    const lockedEmail = `locked-${randomUUID()}@omnihub.test`;
    const cashierEmail = `cashier-${randomUUID()}@omnihub.test`;
    const managerEmail = `manager-${randomUUID()}@omnihub.test`;
    const passwordHash = hashPassword('RestaurantPass123!');

    const db = createFakeAuthDb({
      [lockedEmail]: { id: randomUUID(), passwordHash, active: true, storeId: 'store-1' },
      [cashierEmail]: { id: randomUUID(), passwordHash, active: true, storeId: 'store-1' },
      [managerEmail]: { id: randomUUID(), passwordHash, active: true, storeId: 'store-1' },
    });

    // Account 1 fails 10 times from the shared restaurant NAT IP and becomes locked.
    for (let i = 0; i < 10; i++) {
      const ipSlot = await incrementRateWindow(i % 2 ? r1 : r2, natIpKey, 60_000);
      expect(ipSlot.count).toBeLessThanOrEqual(60);
      await expect(
        login(db, lockedEmail, 'BadPass!', 'store-1', { redis: i % 2 ? r1 : r2, limit: 10, windowMs: 60_000 }),
      ).rejects.toThrow();
    }
    expect((await checkAccountLoginLock(r1, lockedEmail)).locked).toBe(true);

    // Accounts 2 and 3 on the exact same NAT IP still pass IP limit (11, 12 <= 60) and log in cleanly.
    const cashierIpSlot = await incrementRateWindow(r2, natIpKey, 60_000);
    expect(cashierIpSlot.count).toBe(11);
    const cashierSession = await login(db, cashierEmail, 'RestaurantPass123!', 'store-1', {
      redis: r2,
      limit: 10,
      windowMs: 60_000,
    });
    expect(cashierSession.token).toMatch(/^[a-f0-9]{64}$/);

    const managerIpSlot = await incrementRateWindow(r1, natIpKey, 60_000);
    expect(managerIpSlot.count).toBe(12);
    const managerSession = await login(db, managerEmail, 'RestaurantPass123!', 'store-1', {
      redis: r1,
      limit: 10,
      windowMs: 60_000,
    });
    expect(managerSession.token).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it('resets failed attempts on valid login via PEXPIRE 0 and does not increment on membership mismatch', async () => {
    const { first: r1, second: r2 } = await ensureConnected();
    const email = `reset-${randomUUID()}@omnihub.test`;
    const passwordHash = hashPassword('ResetPass123!');
    const db = createFakeAuthDb({
      [email]: { id: randomUUID(), passwordHash, active: true, storeId: 'store-1' },
    });

    // 4 failed password attempts across both replicas
    for (let i = 0; i < 4; i++) {
      await expect(
        login(db, email, 'WrongPass!', 'store-1', { redis: i % 2 ? r1 : r2, limit: 5, windowMs: 60_000 }),
      ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    }
    expect(await r1.pttl(accountFailureKey(email))).toBeGreaterThan(0);

    // Valid password on wrong storeId fails with 401 but MUST NOT trigger 5th-attempt lockout
    await expect(
      login(db, email, 'ResetPass123!', 'wrong-store', { redis: r2, limit: 5, windowMs: 60_000 }),
    ).rejects.toMatchObject({ message: 'INVALID_CREDENTIALS' });
    expect((await checkAccountLoginLock(r1, email)).locked).toBe(false);

    // Valid login on store-1 expires failure key immediately via PEXPIRE 0 without DEL
    const session = await login(db, email, 'ResetPass123!', 'store-1', { redis: r1, limit: 5, windowMs: 60_000 });
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await r2.pttl(accountFailureKey(email))).toBeLessThanOrEqual(0);
    expect(await r2.pttl(accountLockKey(email))).toBeLessThanOrEqual(0);

    // Next wrong password starts fresh at count = 1 instead of locking at 5
    const nextFail = await recordAccountLoginFailure(r2, email, { limit: 5, windowMs: 60_000 });
    expect(nextFail.count).toBe(1);
    expect(nextFail.locked).toBe(false);
  }, 30_000);

  it('executes all dual-key Lua scripts cleanly under the staging Redis 7 ACL without DEL or NOPERM', async () => {
    const { first: adminRedis } = await ensureConnected();
    const aclUser = `omnihub_rate_acl_${randomBytes(4).toString('hex')}`;
    const aclPassword = randomBytes(16).toString('hex');

    await adminRedis.acl(
      'SETUSER',
      aclUser,
      'on',
      `>${aclPassword}`,
      '~omnihub:rate:*',
      '&omnihub.events',
      '&omnihub:socket.io#/#*',
      '&omnihub:socket.io-request#*',
      '&omnihub:socket.io-response#*',
      '-@all',
      '+ping',
      '+echo',
      '+hello',
      '+quit',
      '+select',
      '+client|setinfo',
      '+client|setname',
      '+info',
      '+eval',
      '+incr',
      '+pexpire',
      '+pttl',
      '+publish',
      '+subscribe',
      '+unsubscribe',
      '+psubscribe',
      '+punsubscribe',
      '+pubsub|numsub',
    );

    const parsed = new URL(process.env.REDIS_URL!);
    parsed.username = aclUser;
    parsed.password = aclPassword;
    const aclClient = new Redis(parsed.toString(), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    aclClient.on('error', () => undefined);

    try {
      await aclClient.connect();
      const email = `acl-${randomUUID()}@omnihub.test`;

      expect((await checkAccountLoginLock(aclClient, email)).locked).toBe(false);
      const f1 = await recordAccountLoginFailure(aclClient, email, { limit: 2, windowMs: 60_000 });
      expect(f1).toMatchObject({ count: 1, locked: false, newlyLocked: false });

      const f2 = await recordAccountLoginFailure(aclClient, email, { limit: 2, windowMs: 60_000 });
      expect(f2).toMatchObject({ count: 2, locked: true, newlyLocked: true });
      expect((await checkAccountLoginLock(aclClient, email)).locked).toBe(true);

      await resetAccountLoginFailures(aclClient, email);
      expect((await checkAccountLoginLock(aclClient, email)).locked).toBe(false);

      // Confirm DEL is genuinely forbidden by the staging ACL
      await expect(aclClient.del(accountFailureKey(email))).rejects.toThrow(/NOPERM/i);
    } finally {
      await aclClient.quit().catch(() => aclClient.disconnect());
      await adminRedis.acl('DELUSER', aclUser).catch(() => undefined);
    }
  }, 20_000);

  it('enforces the dedicated 10 req/min rate limit on /public/invitations/ across Redis clients', async () => {
    const { first: r1, second: r2 } = await ensureConnected();
    const clientIp = `203.0.113.${Math.floor(Math.random() * 200) + 10}:${randomUUID()}`;

    const makeStack = (redis: Redis) => {
      const routes: Array<{ path: string; handler: ReturnType<typeof createRedisRateLimiter> }> = [];
      configurePublicAndAuthRateLimits(
        {
          use(path, handler) {
            routes.push({ path, handler });
          },
        },
        redis,
        { PUBLIC_INVITATION_RATE_LIMIT: '10', PUBLIC_API_RATE_LIMIT: '60', RATE_LIMIT_WINDOW_SECONDS: '60' },
      );
      return routes;
    };

    const stack1 = makeStack(r1);
    const stack2 = makeStack(r2);

    const sendInvitationRequest = async (
      routes: Array<{ path: string; handler: ReturnType<typeof createRedisRateLimiter> }>,
    ) => {
      const req = { ip: clientIp, socket: { remoteAddress: clientIp } } as Record<string, unknown>;
      const headers = new Map<string, string | number>();
      let statusCode = 200;
      let body: unknown;
      const matching = routes.filter(r => '/public/invitations/tok/accept'.startsWith(r.path));
      let idx = 0;
      await new Promise<void>(resolve => {
        const res = {
          setHeader(k: string, v: string | number) {
            headers.set(k, v);
            return this;
          },
          getHeader() {
            return 'inv-corr';
          },
          status(c: number) {
            statusCode = c;
            return this;
          },
          json(b: unknown) {
            body = b;
            resolve();
            return this;
          },
        };
        const next = () => {
          const current = matching[idx++];
          if (!current) {
            resolve();
            return;
          }
          current.handler(req as never, res as never, next);
        };
        next();
      });
      return { statusCode, headers, body };
    };

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await sendInvitationRequest(i % 2 === 0 ? stack1 : stack2);
      statuses.push(res.statusCode);
      expect(res.headers.get('RateLimit-Limit')).toBe(10);
      if (res.statusCode === 429) {
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
      }
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
  }, 20_000);
});
