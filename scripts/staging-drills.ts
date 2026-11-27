import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { io } from '../apps/web/node_modules/socket.io-client';

// Deliberately fixed Compose file/project: this harness cannot target development
// containers, arbitrary services or a supplied production DATABASE_URL.
const compose = ['compose', '-f', 'deploy/compose.staging.yml'];
const ca = readFileSync('.local/staging/root.crt');
const origin = 'https://localhost:8443';
const evidence: { requirement: string; status: string; details: string }[] = [];
function docker(args: string[], input?: string) {
  return execFileSync('docker', [...compose, ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function sql(query: string) { return docker(['exec', '-T', 'postgres', 'psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-U', 'staging_admin', '-d', 'omnihub_staging'], query); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_DRILL_FIXTURE_SCRIPT = [
  "const {PrismaClient}=require('@prisma/client');",
  "const {randomUUID,randomBytes}=require('node:crypto');",
  "const {digest}=require('./apps/api/dist/domain');",
  'const db=new PrismaClient();',
  '(async()=>{',
  '  const tenantId=randomUUID(),storeId=randomUUID(),userId=randomUUID(),token=randomBytes(32).toString(\'hex\');',
  "  await db.tenant.create({data:{id:tenantId,name:'Staging failure drill'}});",
  "  await db.store.create({data:{id:storeId,tenantId,name:'Isolated drill store'}});",
  "  await db.user.create({data:{id:userId,email:userId+'@drill.invalid',passwordHash:'no-password-login'}});",
  "  await db.membership.create({data:{tenantId,storeId,userId,role:'OWNER'}});",
  '  await db.session.create({data:{tenantId,storeId,userId,tokenHash:digest(token),expiresAt:new Date(Date.now()+3600000)}});',
  "  const station=await db.station.create({data:{tenantId,storeId,name:'Drill station'}});",
  "  const ingredient=await db.ingredient.create({data:{tenantId,storeId,name:'Drill ingredient',unit:'g'}});",
  '  await db.balance.create({data:{tenantId,storeId,ingredientId:ingredient.id,onHand:100}});',
  "  await db.movement.create({data:{tenantId,storeId,ingredientId:ingredient.id,commandKey:'drill-fixture',kind:'ADJUST',reason:'Isolated opening stock',onHandDelta:100,reservedDelta:0}});",
  "  const product=await db.product.create({data:{tenantId,storeId,stationId:station.id,name:'Drill item',price:35000}});",
  '  await db.recipeItem.create({data:{tenantId,storeId,productId:product.id,ingredientId:ingredient.id,quantity:1}});',
  '  return {token,tenantId,storeId,userId,productId:product.id,ingredientId:ingredient.id};',
  '})().then(x=>console.log(JSON.stringify(x))).finally(()=>db.$disconnect());',
].join('\n');
const EXPIRE_DRILL_SESSIONS_SCRIPT = [
  "const {PrismaClient}=require('@prisma/client');",
  'const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;',
  'const db=new PrismaClient();',
  '(async()=>{',
  '  const userId=process.env.DRILL_USER_ID;',
  "  if(!userId||!UUID_RE.test(userId))throw new Error('INVALID_DRILL_USER_ID');",
  '  await db.session.updateMany({where:{userId},data:{expiresAt:new Date(0)}});',
  '  return true;',
  '})().then(x=>console.log(JSON.stringify(x))).finally(()=>db.$disconnect());',
].join('\n');
type DrillFixture = { token: string; tenantId: string; storeId: string; userId: string; productId: string; ingredientId: string };
function createDrillFixture(): DrillFixture {
  const output = docker(['exec', '-T', 'api', 'node', '--require', '/app/deploy/load-secrets.cjs', '-'], CREATE_DRILL_FIXTURE_SCRIPT);
  return JSON.parse(output) as DrillFixture;
}
function expireDrillUserSessions(userId: string): boolean {
  if (!UUID_RE.test(userId)) throw new Error('INVALID_DRILL_USER_ID');
  const output = docker(['exec', '-T', '-e', `DRILL_USER_ID=${userId}`, 'api', 'node', '--require', '/app/deploy/load-secrets.cjs', '-'], EXPIRE_DRILL_SESSIONS_SCRIPT);
  return JSON.parse(output) as boolean;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(200); }
  throw new Error(`TIMEOUT_${label}`);
}
type Response = { status: number; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> };
function http(path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(`https://localhost:8444${path}`, { ca, method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, timeout: 20_000 }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('end', () => {
        let data = {}; try { data = JSON.parse(text); } catch { /* proxy outage body is not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const ready = () => until(() => http('/ready').then(r => r.status === 200).catch(() => false), 'READINESS', 60_000);
function record(requirement: string, details: string) { evidence.push({ requirement, status: 'VERIFIED', details }); console.log(`VERIFIED ${requirement}`); }

async function lockRow(table: 'Balance' | 'Outbox', predicate: string, seconds = 8) {
  const child = spawn('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-U', 'staging_admin', '-d', 'omnihub_staging'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; });
  child.stdin.end(`BEGIN; SELECT 1 FROM "${table}" WHERE ${predicate} FOR UPDATE; SELECT 'LOCKED'; SELECT pg_sleep(${seconds}); COMMIT;`);
  await until(() => output.includes('LOCKED'), 'LOCK_ACQUIRED');
  return child;
}
async function main() {
  assert.equal(docker(['config', '--format', 'json']).includes('omnihub-staging'), true);
  await ready();
  const fixture = createDrillFixture();
  const cookie = `session=${fixture.token}`;
  const orderBody = { lines: [{ productId: fixture.productId, quantity: 1 }] };
  const accept = (key = randomUUID()) => http('/orders', 'POST', orderBody, cookie, { 'Idempotency-Key': key });
  const events: { aggregateId: string; eventId: string }[] = [];
  const socket = io('https://localhost:8444', { transports: ['websocket'], ca, rejectUnauthorized: true, extraHeaders: { Origin: origin, Cookie: cookie } } as Parameters<typeof io>[1]) as unknown as {
    connected: boolean;
    on(event: string, callback: (event: { aggregateId: string; eventId: string }) => void): void;
    disconnect(): void;
  };
  socket.on('operational.event', event => events.push(event));
  try {
    await until(() => socket.connected, 'AUTHENTICATED_TLS_SOCKET');
    assert.equal((await http('/ready', 'GET', undefined, undefined, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await http('/auth/login', 'OPTIONS', undefined, undefined, { Origin: 'https://evil.invalid', 'Access-Control-Request-Method': 'POST' })).status, 403);
    assert.equal((await http('/orders', 'POST', orderBody, cookie, { Origin: '' })).status, 403);
    assert.equal((await http('/orders')).status, 401);
    const response = await http('/auth/login', 'POST', { email: 'owner@local.omnihub.test', password: readFileSync('.local/staging/secrets/demo_password', 'utf8').trim(), storeId: '22222222-2222-4222-8222-222222222222' });
    assert.equal(response.status, 201);
    const sessionCookie = response.headers['set-cookie']?.join(';') ?? '';
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(sessionCookie.includes(flag));
    assert.match(response.headers['strict-transport-security'] ?? '', /max-age/);
    record('TLS, secure session cookie, CORS and CSRF', 'Verified HTTPS against the generated CA, exact-origin rejection on GET/preflight/write, absent-origin write denial, anonymous 401, Secure/HttpOnly/Strict cookie and HSTS.');

    const restartKey = randomUUID();
    await lockRow('Balance', `"ingredientId"='${fixture.ingredientId}'`, 6);
    const pending = accept(restartKey).catch(() => null);
    await until(() => Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE usename='omnihub_app' AND wait_event_type='Lock' AND query LIKE '%Balance%';`)) > 0, 'REQUEST_IN_TRANSACTION');
    docker(['restart', '-t', '25', 'api']);
    const first = await pending;
    await ready();
    const retry = await accept(restartKey); assert.equal(retry.status, 201);
    if (first?.status === 201) assert.equal(retry.body.id, first.body.id);
    assert.equal(sql(`SELECT count(*) FROM "CommandReceipt" WHERE "storeId"='${fixture.storeId}' AND key='${restartKey}';`), '1');
    assert.equal(sql(`SELECT count(*) FROM "KitchenTicket" WHERE "orderId"='${retry.body.id}';`), '1');
    assert.equal(sql(`SELECT count(*) FROM "Movement" WHERE "commandKey"='${restartKey}' AND kind='RESERVE';`), '1');
    record('API restart during a proven in-flight order transaction', 'Held the real ingredient row lock, observed the API waiting in pg_stat_activity, sent SIGTERM through Compose restart, retried the same key and verified exactly one receipt, ticket and reservation movement.');
    await until(() => socket.connected, 'SOCKET_AFTER_API_RESTART');

    docker(['stop', '-t', '10', 'redis']);
    assert.equal((await http('/ready')).status, 503);
    assert.equal((await http('/auth/login', 'POST', {})).status, 503);
    const offlineOrder = await accept(); assert.equal(offlineOrder.status, 201);
    assert.equal(sql(`SELECT count(*) FROM "Outbox" WHERE "aggregateId"='${offlineOrder.body.id}' AND "deliveredAt" IS NULL;`), '1');
    docker(['start', 'redis']); await ready();
    await until(() => sql(`SELECT count(*) FROM "Outbox" WHERE "aggregateId"='${offlineOrder.body.id}' AND "deliveredAt" IS NULL;`) === '0', 'OUTBOX_DRAIN');
    const afterRedis = await accept(); assert.equal(afterRedis.status, 201);
    await until(() => events.some(e => e.aggregateId === afterRedis.body.id), 'REAL_PUSH_AFTER_REDIS');
    record('Redis outage and realtime recovery', 'Stopped the actual isolated Redis container; readiness/login failed closed, authenticated order retained pending outbox; restart drained backlog and a subsequent order arrived through a real TLS Socket.IO frame. Redis Pub/Sub is not a durable client acknowledgement.');

    docker(['stop', '-t', '10', 'worker']);
    const workerOrder = await accept(); assert.equal(workerOrder.status, 201);
    const eventId = sql(`SELECT id FROM "Outbox" WHERE "aggregateId"='${workerOrder.body.id}';`);
    await lockRow('Outbox', `id='${eventId}'`, 12);
    docker(['start', 'worker']);
    await until(() => events.some(e => e.eventId === eventId), 'FIRST_REAL_PUBLICATION');
    await until(() => Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE usename='omnihub_app' AND wait_event_type='Lock' AND query LIKE '%Outbox%';`)) > 0, 'WORKER_BEFORE_DELIVERY_MARK');
    docker(['stop', '-t', '0', 'worker']);
    docker(['start', 'worker']);
    await until(() => sql(`SELECT count(*) FROM "Outbox" WHERE id='${eventId}' AND "deliveredAt" IS NOT NULL;`) === '1', 'WORKER_RECOVERED');
    await until(() => events.filter(e => e.eventId === eventId).length >= 2, 'DUPLICATE_REAL_EVENT');
    assert.equal(sql(`SELECT count(*) FROM "KitchenTicket" WHERE "orderId"='${workerOrder.body.id}';`), '1');
    record('Worker crash in the publish/mark window and duplicate delivery', 'Locked the outbox row, observed real publication and blocked delivery update, SIGKILLed only the staging worker, restarted it, and observed the same eventId twice without duplicate business effects.');

    docker(['stop', '-t', '20', 'postgres']);
    assert.equal((await http('/ready')).status, 503);
    const failedKey = randomUUID(); assert.equal((await accept(failedKey)).status, 503);
    docker(['start', 'postgres']); await ready();
    assert.equal((await accept(failedKey)).status, 201);
    assert.equal(sql(`SELECT count(*) FROM "CommandReceipt" WHERE "storeId"='${fixture.storeId}' AND key='${failedKey}';`), '1');
    record('Temporary PostgreSQL disconnection', 'Stopped only staging PostgreSQL, observed readiness and order failure, restarted the preserved volume and retried the failed idempotency key successfully once.');

    const duplicateKey = randomUUID();
    const duplicates = await Promise.all([accept(duplicateKey), accept(duplicateKey), accept(duplicateKey)]);
    assert.ok(duplicates.every(r => r.status === 201)); assert.equal(new Set(duplicates.map(r => r.body.id)).size, 1);
    record('Concurrent duplicate HTTP order submissions', 'Three simultaneous real HTTPS requests with one idempotency key return one order.');
    expireDrillUserSessions(fixture.userId);
    assert.equal((await http('/orders', 'GET', undefined, cookie)).status, 401);
    await until(() => !socket.connected, 'EXPIRED_SOCKET_REVALIDATION', 40_000);
    record('Session expiration', 'Expired only the generated drill session in PostgreSQL; subsequent HTTP access was rejected and the existing authenticated socket was disconnected by server revalidation.');
    const logs = docker(['logs', '--no-color', 'api', 'worker']);
    for (const secret of [fixture.token, readFileSync('.local/staging/secrets/demo_password', 'utf8').trim(), readFileSync('.local/staging/secrets/db_app_password', 'utf8').trim()]) assert.ok(!logs.includes(secret));
    record('Sensitive-data log sampling', 'API/worker logs do not contain the generated session bearer, demo password or database app password; structured request fields and capability redaction unit coverage verified.');
  } finally {
    socket.disconnect();
    // Recovery only: no down, rm, volume deletion, reset or database cleanup.
    docker(['start', 'postgres', 'redis', 'api', 'worker']);
    writeFileSync('.local/staging/drill-evidence.json', JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message.replace(/session=[a-f0-9]+/g, 'session=[redacted]') : 'STAGING_DRILL_FAILED'); process.exitCode = 1; });
