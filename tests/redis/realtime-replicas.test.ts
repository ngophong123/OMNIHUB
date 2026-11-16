import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Redis from '../../apps/api/node_modules/ioredis';

type ClientSocket = {
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  close(): void;
};
const requireFromWeb = createRequire(join(process.cwd(), 'apps/web/package.json'));
const { io: createSocketClient } = requireFromWeb('socket.io-client') as {
  io: (url: string, opts: Record<string, unknown>) => ClientSocket;
};
import { db } from '../../apps/api/src/database';
import { digest, hashPassword } from '../../apps/api/src/domain';
import { attachRealtime, realtimeRedisReady } from '../../apps/api/src/realtime';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP_PORT_REQUIRED');
  await new Promise<void>((resolvePromise, reject) => server.close(error => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function waitForReady(port: number, proc: ChildProcess) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`API_REPLICA_EXITED(${proc.exitCode})`);
    const ok = await fetch(`http://127.0.0.1:${port}/ready`)
      .then(response => response.status === 200)
      .catch(() => false);
    if (ok) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('API_REPLICA_NOT_READY');
}

function connectSocket(port: number, origin: string, cookieToken: string, deviceId?: string): Promise<ClientSocket> {
  return new Promise((resolvePromise, reject) => {
    const client = createSocketClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin, cookie: `session=${cookieToken}` },
      auth: deviceId ? { deviceId } : undefined,
    });
    client.once('connect', () => resolvePromise(client));
    client.once('connect_error', reject);
  });
}

describe('multi-replica Socket.IO Redis adapter & instant revocation (M2-T09)', () => {
  it('routes broadcasts, enforces tenant isolation, and immediately revokes sessions & kitchen devices across two API replicas', async () => {
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
    const origin = 'http://localhost:3000';
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    redis.on('error', () => undefined);

    const tenantA = randomUUID();
    const storeA = randomUUID();
    const tenantB = randomUUID();
    const storeB = randomUUID();
    const ownerId = randomUUID();
    const kitchenUserId = randomUUID();
    const userBId = randomUUID();
    const stationId = randomUUID();
    const deviceId = randomUUID();

    const ownerToken = randomBytes(32).toString('hex');
    const kitchenToken = randomBytes(32).toString('hex');
    const tenantBToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600_000);

    const children: ChildProcess[] = [];
    const sockets: ClientSocket[] = [];

    try {
      await redis.connect();
      expect(await redis.ping()).toBe('PONG');

      await db.tenant.createMany({
        data: [
          { id: tenantA, name: 'Replica Tenant A' },
          { id: tenantB, name: 'Replica Tenant B' },
        ],
      });
      await db.store.createMany({
        data: [
          { id: storeA, tenantId: tenantA, name: 'Replica Store A' },
          { id: storeB, tenantId: tenantB, name: 'Replica Store B' },
        ],
      });
      await db.user.createMany({
        data: [
          { id: ownerId, email: `rep-owner-${tenantA}@omnihub.test`, passwordHash: hashPassword('OwnerPass123!'), active: true },
          { id: kitchenUserId, email: `rep-kitchen-${tenantA}@omnihub.test`, passwordHash: hashPassword('KitchenPass123!'), active: true },
          { id: userBId, email: `rep-owner-${tenantB}@omnihub.test`, passwordHash: hashPassword('OwnerPass123!'), active: true },
        ],
      });
      await db.membership.createMany({
        data: [
          { tenantId: tenantA, storeId: storeA, userId: ownerId, role: 'OWNER' },
          { tenantId: tenantA, storeId: storeA, userId: kitchenUserId, role: 'KITCHEN' },
          { tenantId: tenantB, storeId: storeB, userId: userBId, role: 'OWNER' },
        ],
      });
      await db.session.createMany({
        data: [
          { tokenHash: digest(ownerToken), tenantId: tenantA, storeId: storeA, userId: ownerId, expiresAt },
          { tokenHash: digest(kitchenToken), tenantId: tenantA, storeId: storeA, userId: kitchenUserId, expiresAt },
          { tokenHash: digest(tenantBToken), tenantId: tenantB, storeId: storeB, userId: userBId, expiresAt },
        ],
      });
      await db.station.create({ data: { id: stationId, tenantId: tenantA, storeId: storeA, name: 'Pass', active: true } });
      await db.kitchenDevice.create({ data: { id: deviceId, tenantId: tenantA, storeId: storeA, userId: kitchenUserId, stationId } });

      const ports = [await availablePort(), await availablePort()];
      for (const port of ports) {
        children.push(
          spawn(process.execPath, [resolve('apps/api/dist/main.js')], {
            cwd: resolve('.'),
            windowsHide: true,
            stdio: 'ignore',
            env: {
              ...process.env,
              API_HOST: '127.0.0.1',
              PORT: String(port),
              TRUSTED_PROXY_CIDRS: 'loopback',
              WEB_ORIGIN: origin,
            },
          }),
        );
      }
      await Promise.all(ports.map((port, index) => waitForReady(port, children[index]!)));

      const ownerReplica1 = await connectSocket(ports[0]!, origin, ownerToken);
      const kitchenReplica2 = await connectSocket(ports[1]!, origin, kitchenToken, deviceId);
      const tenantBReplica2 = await connectSocket(ports[1]!, origin, tenantBToken);
      sockets.push(ownerReplica1, kitchenReplica2, tenantBReplica2);

      const ownerEvents: string[] = [];
      const tenantBEvents: string[] = [];
      ownerReplica1.on('operational.event', e => ownerEvents.push((e as { type: string }).type));
      tenantBReplica2.on('operational.event', e => tenantBEvents.push((e as { type: string }).type));

      // Outbox broadcast reaches authorized store sockets on Replica 1 once and never leaks to Tenant B on Replica 2.
      const eventId = randomUUID();
      const orderEvent = JSON.stringify({
        eventId,
        schemaVersion: 1,
        tenantId: tenantA,
        storeId: storeA,
        type: 'order.accepted',
        aggregateId: randomUUID(),
        version: 1,
        occurredAt: new Date().toISOString(),
      });
      await redis.publish('omnihub.events', orderEvent);
      await redis.publish('omnihub.events', orderEvent);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));

      expect(ownerEvents).toEqual(['order.accepted']);
      expect(tenantBEvents).toEqual([]);

      // Revoking kitchen device on Replica 1 immediately disconnects kitchen socket on Replica 2.
      const kitchenDisconnected = new Promise<void>(resolvePromise => kitchenReplica2.once('disconnect', () => resolvePromise()));
      const revokeRes = await fetch(`http://127.0.0.1:${ports[0]}/admin/kitchen/devices/${deviceId}/revoke`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: `session=${ownerToken}` },
      });
      expect(revokeRes.status).toBe(201);
      await Promise.race([
        kitchenDisconnected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('KITCHEN_DISCONNECT_TIMEOUT')), 4_000)),
      ]);
      expect(kitchenReplica2.connected).toBe(false);

      // Logging out owner session on Replica 2 immediately disconnects owner socket on Replica 1.
      const ownerDisconnected = new Promise<void>(resolvePromise => ownerReplica1.once('disconnect', () => resolvePromise()));
      const logoutRes = await fetch(`http://127.0.0.1:${ports[1]}/auth/logout`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: `session=${ownerToken}` },
      });
      expect(logoutRes.status).toBe(201);
      await Promise.race([
        ownerDisconnected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OWNER_DISCONNECT_TIMEOUT')), 4_000)),
      ]);
      expect(ownerReplica1.connected).toBe(false);
      expect(tenantBReplica2.connected).toBe(true);
    } finally {
      for (const sock of sockets) sock.close();
      await Promise.all(
        children.map(
          child =>
            new Promise<void>(resolvePromise => {
              if (child.exitCode !== null) return resolvePromise();
              child.once('exit', () => resolvePromise());
              child.kill();
            }),
        ),
      );
      await db.outbox.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
      await db.session.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
      await db.$disconnect();
      redis.disconnect();
    }
  }, 60_000);

  it('fails readiness closed and enforces real Redis 7 ACL least-privilege permissions without crashing', async () => {
    const unusedPort = await availablePort();
    const server = createHttpServer();
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));

    const closeOffline = attachRealtime(server, 'http://localhost:3000', {
      redisUrl: `redis://127.0.0.1:${unusedPort}`,
    });
    try {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
      expect(await realtimeRedisReady()).toBe(false);
    } finally {
      await closeOffline();
    }

    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
    const adminRedis = new Redis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    adminRedis.on('error', () => undefined);
    const aclPassword = randomBytes(16).toString('hex');
    const goodUser = `omnihub_rt_ok_${randomBytes(4).toString('hex')}`;
    const badUser = `omnihub_rt_bad_${randomBytes(4).toString('hex')}`;

    try {
      await adminRedis.connect();
      const baseParsed = new URL(process.env.REDIS_URL);

      // Exact staging ACL from deploy/redis-start.sh succeeds cleanly for Socket.IO Redis adapter + Outbox subscriber.
      await adminRedis.acl(
        'SETUSER',
        goodUser,
        'on',
        `>${aclPassword}`,
        '~omnihub:rate:*',
        '&omnihub.events',
        '&omnihub:socket.io#*',
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
      const goodUrl = new URL(baseParsed.toString());
      goodUrl.username = goodUser;
      goodUrl.password = aclPassword;
      const closeGood = attachRealtime(server, 'http://localhost:3000', { redisUrl: goodUrl.toString() });
      try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !(await realtimeRedisReady())) {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
        }
        expect(await realtimeRedisReady()).toBe(true);
      } finally {
        await closeGood();
      }

      // Restricted ACL missing +psubscribe & +pubsub|numsub fails readiness closed with NOPERM without crashing process.
      await adminRedis.acl(
        'SETUSER',
        badUser,
        'on',
        `>${aclPassword}`,
        '&omnihub.events',
        '-@all',
        '+ping',
        '+hello',
        '+quit',
        '+select',
        '+client|setinfo',
        '+client|setname',
        '+subscribe',
        '+unsubscribe',
      );
      const badUrl = new URL(baseParsed.toString());
      badUrl.username = badUser;
      badUrl.password = aclPassword;
      const closeBad = attachRealtime(server, 'http://localhost:3000', { redisUrl: badUrl.toString() });
      try {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
        expect(await realtimeRedisReady()).toBe(false);
      } finally {
        await closeBad();
      }
    } finally {
      await adminRedis.acl('DELUSER', goodUser, badUser).catch(() => undefined);
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      adminRedis.disconnect();
    }
  });
});
