import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Redis from '../../apps/api/node_modules/ioredis';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP_PORT_REQUIRED');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function ready(port: number, process: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error('API_REPLICA_EXITED');
    if (await fetch(`http://127.0.0.1:${port}/ready`).then(response => response.status === 200).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API_REPLICA_NOT_READY');
}

describe('real HTTP API replicas', () => {
  it('share one Redis login limit across separate API processes', async () => {
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    redis.on('error', () => undefined);
    const clientIp = `2001:db8:${randomBytes(12).toString('hex').match(/.{4}/g)!.join(':')}`;
    const children: ChildProcess[] = [];
    try {
      await redis.connect(); expect(await redis.ping()).toBe('PONG');
      const ports = [await availablePort(), await availablePort()];
      for (const port of ports) {
        children.push(spawn(process.execPath, [resolve('apps/api/dist/main.js')], {
          cwd: resolve('.'), windowsHide: true, stdio: 'ignore',
          env: { ...process.env, API_HOST: '127.0.0.1', PORT: String(port), AUTH_LOGIN_RATE_LIMIT: '2', RATE_LIMIT_WINDOW_SECONDS: '60', TRUSTED_PROXY_CIDRS: 'loopback', WEB_ORIGIN: 'http://localhost:3000' },
        }));
      }
      await Promise.all(ports.map((port, index) => ready(port, children[index]!)));
      const statuses = [];
      for (const port of [ports[0], ports[1], ports[0]]) {
        const response = await fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp }, body: '{}',
        });
        statuses.push(response.status);
        expect(response.headers.get('ratelimit-limit')).toBe('2');
        if (response.status === 429) { expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0); expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' }); }
      }
      expect(statuses).toEqual([400, 400, 429]);
    } finally {
      await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill(); })));
      // The production ACL intentionally denies DEL; the unique login key
      // expires when the configured rate-limit window ends.
      redis.disconnect();
    }
  }, 45_000);
});
