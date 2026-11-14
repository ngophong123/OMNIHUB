import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';

const compose = ['compose', '-f', 'deploy/compose.staging.yml', '--profile', 'backup', '--profile', 'tools'];
function docker(args: string[], input?: string) {
  return execFileSync('docker', [...compose, ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function query(db: string, statement: string) {
  return docker(['exec', '-T', 'postgres', 'psql', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-U', 'staging_admin', '-d', db], statement);
}
async function copyArchive(target: string, archive: string) {
  const source = spawn('docker', [...compose, 'exec', '-T', 'backup', 'cat', archive], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const restore = spawn('docker', [...compose, 'exec', '-T', 'postgres', 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-U', 'staging_admin', '-d', target], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  source.stdout.pipe(restore.stdin);
  let sourceError = ''; let restoreError = '';
  source.stderr.on('data', b => { sourceError += b; });
  restore.stderr.on('data', b => { restoreError += b; });
  const exits = await Promise.all([source, restore].map(child => new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); })));
  assert.deepEqual(exits, [0, 0], `RESTORE_STREAM_FAILED ${sourceError.slice(0, 200)} ${restoreError.slice(0, 200)}`);
}
async function main() {
  const started = Date.now();
  const target = `omnihub_staging_restore_${Date.now()}_${randomBytes(4).toString('hex')}`;
  assert.equal(query('omnihub_staging', `SELECT count(*) FROM pg_database WHERE datname='${target}';`), '0');
  const verified = JSON.parse(docker(['exec', '-T', 'backup', 'cat', '/state/verified.json'])) as { snapshotId: string; recoveryPointUnix: number; verifiedUnix: number; dumpBytes: number };
  assert.match(verified.snapshotId, /^[a-f0-9]{64}$/);
  assert.ok(verified.dumpBytes >= 1024);
  const rpoAgeAtStartSeconds = Math.floor(Date.now() / 1000) - verified.recoveryPointUnix;
  assert.ok(rpoAgeAtStartSeconds >= 0 && rpoAgeAtStartSeconds < 900, `BACKUP_STALE_${rpoAgeAtStartSeconds}`);
  const recoveryStarted = Date.now();
  // The archive is encrypted at rest. Restic verifies its own repository and
  // extraction happens only into this backup container's private tmpfs.
  const restoreDirectory = `/tmp/restored-${target}`;
  docker(['exec', '-T', 'backup', 'restic', 'restore', verified.snapshotId, '--target', restoreDirectory]);
  docker(['exec', '-T', 'backup', 'sh', '-c', 'cd "$1" && sha256sum -c database.dump.sha256 && pg_restore --list database.dump >/dev/null', 'sh', restoreDirectory]);
  query('omnihub_staging', `CREATE DATABASE ${target};`);
  const restoreStarted = Date.now();
  await copyArchive(target, `${restoreDirectory}/database.dump`);
  const restoreMs = Date.now() - restoreStarted;
  const targetCounts = query(target, `SELECT jsonb_object_agg(relname, n) FROM (SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::integer AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r') q;`);
  const tableNames = `SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';`;
  assert.deepEqual(JSON.parse(query(target, tableNames)), JSON.parse(query('omnihub_staging', tableNames)), 'RESTORED_SCHEMA_TABLES_DIFFER');
  const migrations = readdirSync('prisma/migrations', { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
  assert.equal(Number(query(target, 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')), migrations);
  assert.equal(query('omnihub_staging', `SELECT count(*) FROM pg_database WHERE datname='${target}';`), '1');
  const criticalCounts = JSON.parse(query(target, `SELECT json_build_object('stores',(SELECT count(*) FROM "Store"),'users',(SELECT count(*) FROM "User"),'orders',(SELECT count(*) FROM "Order"),'payments',(SELECT count(*) FROM "Payment"),'refunds',(SELECT count(*) FROM "Refund"),'cashShifts',(SELECT count(*) FROM "CashShift"),'balances',(SELECT count(*) FROM "Balance"),'audits',(SELECT count(*) FROM "Audit"),'outbox',(SELECT count(*) FROM "Outbox"),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),'invalidBalances',(SELECT count(*) FROM "Balance" WHERE "onHand"<0 OR reserved<0 OR reserved>"onHand"))`)) as Record<string, number>;
  assert.equal(criticalCounts.unvalidatedConstraints, 0);
  assert.equal(criticalCounts.invalidBalances, 0);
  const brokenRelationships = JSON.parse(query(target, `SELECT json_build_object(
    'membershipStore',(SELECT count(*) FROM "Membership" m LEFT JOIN "Store" s ON s.id=m."storeId" AND s."tenantId"=m."tenantId" WHERE s.id IS NULL),
    'membershipUser',(SELECT count(*) FROM "Membership" m LEFT JOIN "User" u ON u.id=m."userId" WHERE u.id IS NULL),
    'recipeProduct',(SELECT count(*) FROM "RecipeItem" r LEFT JOIN "Product" p ON p.id=r."productId" AND p."storeId"=r."storeId" AND p."tenantId"=r."tenantId" WHERE p.id IS NULL),
    'recipeIngredient',(SELECT count(*) FROM "RecipeItem" r LEFT JOIN "Ingredient" i ON i.id=r."ingredientId" AND i."storeId"=r."storeId" AND i."tenantId"=r."tenantId" WHERE i.id IS NULL),
    'paymentOrder',(SELECT count(*) FROM "Payment" p LEFT JOIN "Order" o ON o.id=p."orderId" AND o."storeId"=p."storeId" AND o."tenantId"=p."tenantId" WHERE o.id IS NULL),
    'paymentShift',(SELECT count(*) FROM "Payment" p LEFT JOIN "CashShift" s ON s.id=p."cashShiftId" AND s."storeId"=p."storeId" AND s."tenantId"=p."tenantId" WHERE p."cashShiftId" IS NOT NULL AND s.id IS NULL)
  )`)) as Record<string, number>;
  assert.ok(Object.values(brokenRelationships).every(count => count === 0), `BROKEN_RELATIONSHIPS ${JSON.stringify(brokenRelationships)}`);
  // pg_restore --no-owner runs as staging_admin, so the restored tables do not
  // inherit the original migration owner's default app grants. Grant DML only
  // in this new target; the app role still cannot perform DDL or TRUNCATE.
  query(target, 'GRANT USAGE ON SCHEMA public TO omnihub_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO omnihub_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO omnihub_app;');
  const types = query(target, "SELECT format('%I.%I', n.nspname, t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d');");
  for (const type of types.split('\n').filter(Boolean)) query(target, `GRANT USAGE ON TYPE ${type} TO omnihub_app;`);
  const recoveryName = `omnihub-staging-recovery-${randomBytes(4).toString('hex')}`;
  let recoveryProbe: { ready: boolean; login: boolean; catalog: boolean; storeIsolation: boolean; tenantIsolation: boolean } | undefined;
  try {
    docker(['run', '-d', '--no-deps', '--name', recoveryName, '-e', `DB_NAME=${target}`, '-e', 'PORT=4002', 'seed', 'node', '--require', '/app/deploy/load-secrets.cjs', 'apps/api/dist/main.js']);
    const startedProbe = Date.now();
    while (Date.now() - startedProbe < 40_000) {
      const status = execFileSync('docker', ['exec', recoveryName, 'node', '-e', "fetch('http://127.0.0.1:4002/ready').then(r=>console.log(r.status)).catch(()=>console.log(0))"], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
      if (status === '200') break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const probe = `import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); const base='http://127.0.0.1:4002'; try { const login=await fetch(base+'/auth/login',{method:'POST',headers:{Origin:'https://localhost:8443','Content-Type':'application/json'},body:JSON.stringify({email:'owner@local.omnihub.test',password:process.env.DEMO_PASSWORD,storeId:'22222222-2222-4222-8222-222222222222'})}); const cookie=login.headers.get('set-cookie')?.split(';')[0]||''; const me=await fetch(base+'/auth/me',{headers:{Cookie:cookie}}); const identity=await me.json(); const own=await fetch(base+'/admin/categories',{headers:{Cookie:cookie}}); const sameStore=await p.store.create({data:{tenantId:identity.tenantId,name:'Recovery same-tenant other store'}}); const otherTenant=await p.tenant.create({data:{name:'Recovery other tenant'}}); const otherStore=await p.store.create({data:{tenantId:otherTenant.id,name:'Recovery other-tenant store'}}); const sameCategory=await p.category.create({data:{tenantId:identity.tenantId,storeId:sameStore.id,name:'PRIVATE_SAME_TENANT'}}); const otherCategory=await p.category.create({data:{tenantId:otherTenant.id,storeId:otherStore.id,name:'PRIVATE_OTHER_TENANT'}}); const scoped=await fetch(base+'/admin/categories',{headers:{Cookie:cookie}}); const payload=JSON.stringify(await scoped.json()); console.log(JSON.stringify({ready:true,login:login.status===201&&me.status===200,catalog:own.status===200,storeIsolation:scoped.status===200&&!payload.includes(sameCategory.id)&&!payload.includes('PRIVATE_SAME_TENANT'),tenantIsolation:scoped.status===200&&!payload.includes(otherCategory.id)&&!payload.includes('PRIVATE_OTHER_TENANT')})); } finally {await p.$disconnect()}`;
    const output = execFileSync('docker', ['exec', recoveryName, 'node', '--require', '/app/deploy/load-secrets.cjs', '--input-type=module', '-e', probe], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
    recoveryProbe = JSON.parse(output) as typeof recoveryProbe;
    assert.deepEqual(recoveryProbe, { ready: true, login: true, catalog: true, storeIsolation: true, tenantIsolation: true });
  } finally {
    // Retain the recovery container and isolated database for review.
    try { execFileSync('docker', ['stop', '-t', '20', recoveryName], { windowsHide: true, stdio: 'ignore', timeout: 30_000 }); } catch { /* Preserve primary failure and artifacts. */ }
  }
  const report = { at: new Date().toISOString(), source: 'omnihub_staging', target, snapshotId: verified.snapshotId, recoveryPointAt: new Date(verified.recoveryPointUnix * 1000).toISOString(), rpoAgeAtStartSeconds, tables: Object.keys(JSON.parse(targetCounts) as object).length, migrations, criticalCounts, brokenRelationships, restoreMs, recoveryDurationMs: Date.now() - recoveryStarted, totalMs: Date.now() - started, localRtoTargetMs: 3_600_000, integrity: 'archive decrypted, checksum matched, migration count and critical relationships verified', serviceRecovery: recoveryProbe, retained: true };
  writeFileSync(`.local/staging/recovery-${target}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'STAGING_BACKUP_VERIFICATION_FAILED'); process.exitCode = 1; });
