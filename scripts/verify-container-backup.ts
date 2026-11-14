import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Local development drill only. Run after stopping application writers.
// The tooling container must already exist; no containers, volumes or DBs are removed.
const source = new URL(process.env.DATABASE_URL ?? '');
if (!['postgresql:', 'postgres:'].includes(source.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('LOCAL_POSTGRES_SOURCE_REQUIRED');
const sourceName = decodeURIComponent(source.pathname.slice(1));
if (!sourceName) throw new Error('SOURCE_DATABASE_REQUIRED');
const container = process.env.PG_TOOL_CONTAINER;
if (!container || !/^omnihub-pg18-tools-[a-zA-Z0-9-]+$/.test(container)) throw new Error('PG_TOOL_CONTAINER must name an existing OMNIHUB PostgreSQL 18 tooling container');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const targetName = `omnihub_restore_verify_${stamp}_${randomBytes(4).toString('hex')}`;
if (sourceName === targetName || !/^omnihub_restore_verify_[0-9]+_[a-f0-9]+$/.test(targetName)) throw new Error('UNSAFE_RESTORE_TARGET');
const directory = resolve('.local/backups'); mkdirSync(directory, { recursive: true });
const backup = resolve(directory, `omnihub-${stamp}.dump`);
const temporaryBackup = `/tmp/omnihub-${stamp}.dump`;
const env = { ...process.env, PGHOST: 'host.docker.internal', PGPORT: source.port || '5432', PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password), PGSSLMODE: source.searchParams.get('sslmode') ?? 'prefer', PGCONNECT_TIMEOUT: '10' };
const credentialArgs = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGCONNECT_TIMEOUT'].flatMap(name => ['-e', name]);
function run(binary: string, args: string[], commandEnv: NodeJS.ProcessEnv = env): string {
  const result = spawnSync(binary, args, { env: commandEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
  // Do not put connection strings, dump contents or PostgreSQL row details in logs.
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0]} failed (exit ${result.status ?? 'unknown'}); artifacts and any isolated database are retained`);
  return result.stdout.trim();
}
const docker = (...args: string[]) => run('docker', args);
const tool = (...args: string[]) => docker('exec', ...credentialArgs, container, ...args);
const sql = (database: string, query: string) => tool('psql', '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--dbname', database, '--command', query);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
function counts(database: string) {
  const tables = JSON.parse(sql(database, `SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'`)) as string[];
  return Object.fromEntries(tables.map(table => [table, Number(sql(database, `SELECT count(*) FROM public.${identifier(table)}`))]));
}
const schemaQuery = `SELECT json_build_object(
  'columns', (SELECT json_agg(r ORDER BY table_name, ordinal_position) FROM (SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public') r),
  'constraints', (SELECT json_agg(r ORDER BY relation, name) FROM (SELECT conrelid::regclass::text AS relation, conname AS name, pg_get_constraintdef(oid, true) AS definition, convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace) r),
  'indexes', (SELECT json_agg(r ORDER BY tablename, indexname) FROM (SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public') r),
  'triggers', (SELECT json_agg(r ORDER BY relation, name) FROM (SELECT tgrelid::regclass::text AS relation, tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) AND NOT tgisinternal) r)
)`;
const integrityQuery = `SELECT json_build_object(
  'unvalidated_constraints', (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),
  'invalid_stock', (SELECT count(*) FROM "Balance" WHERE "onHand" < 0 OR reserved < 0 OR reserved > "onHand"),
  'stock_ledger_mismatch', (SELECT count(*) FROM "Balance" b WHERE b."onHand" <> COALESCE((SELECT sum(m."onHandDelta") FROM "Movement" m WHERE m."tenantId"=b."tenantId" AND m."storeId"=b."storeId" AND m."ingredientId"=b."ingredientId"),0) OR b.reserved <> COALESCE((SELECT sum(m."reservedDelta") FROM "Movement" m WHERE m."tenantId"=b."tenantId" AND m."storeId"=b."storeId" AND m."ingredientId"=b."ingredientId"),0)),
  'overpaid_orders', (SELECT count(*) FROM "Order" o WHERE (SELECT COALESCE(sum(p.amount),0) FROM "Payment" p WHERE p."orderId"=o.id AND p.status IN ('PENDING','SETTLED')) > o.total),
  'excess_refunds', (SELECT count(*) FROM "Payment" p WHERE COALESCE((SELECT sum(r.amount) FROM "Refund" r WHERE r."paymentId"=p.id AND r.status IN ('REQUESTED','APPROVED')),0) + COALESCE((SELECT sum(m.amount) FROM "CashMovement" m WHERE m."paymentId"=p.id AND m.kind='REFUND' AND m."refundId" IS NULL),0) > p.amount),
  'closed_shift_mismatch', (SELECT count(*) FROM "CashShift" s WHERE s.status='CLOSED' AND (s."expectedAmount" IS NULL OR s."countedAmount" IS NULL OR s.discrepancy IS DISTINCT FROM s."countedAmount" - s."expectedAmount" OR s."expectedAmount" <> s."openingAmount" + COALESCE((SELECT sum(p.amount) FROM "Payment" p WHERE p."cashShiftId"=s.id),0) + COALESCE((SELECT sum(CASE WHEN m.kind IN ('CASH_IN','CORRECTION_IN') THEN m.amount ELSE -m.amount END) FROM "CashMovement" m WHERE m."shiftId"=s.id),0)))
)`;
const version = tool('pg_dump', '--version');
if (!/PostgreSQL\) 18\./.test(version)) throw new Error('POSTGRESQL_18_CLIENT_REQUIRED');
const before = counts(sourceName);
const sourceSchema = sql(sourceName, schemaQuery);
tool('pg_dump', '--format=custom', '--no-owner', '--no-acl', '--file', temporaryBackup, '--dbname', sourceName);
tool('pg_restore', '--list', temporaryBackup);
// Docker's archive/cp endpoint cannot read this tmpfs mount. Stream binary bytes
// directly to a private file descriptor; never send dump contents to the terminal.
const backupFd = openSync(backup, 'wx', 0o600);
try {
  const copied = spawnSync('docker', ['exec', container, 'cat', temporaryBackup], { env, windowsHide: true, stdio: ['ignore', backupFd, 'pipe'], timeout: 180_000 });
  if (copied.error || copied.status !== 0) throw new Error('BACKUP_COPY_FAILED: partial artifact retained');
} finally { closeSync(backupFd); }
if (statSync(backup).size === 0) throw new Error('EMPTY_BACKUP');
const checksum = createHash('sha256').update(readFileSync(backup)).digest('hex');
writeFileSync(`${backup}.sha256`, `${checksum}  ${backup.split(/[\\/]/).at(-1)}\n`, { flag: 'wx', mode: 0o600 });
const containerChecksum = tool('sha256sum', temporaryBackup).split(/\s+/)[0];
if (checksum !== containerChecksum) throw new Error('BACKUP_CHECKSUM_MISMATCH');
if (sql('postgres', `SELECT 1 FROM pg_database WHERE datname='${targetName}'`)) throw new Error('TARGET_EXISTS');
const start = Date.now();
sql('postgres', `CREATE DATABASE ${identifier(targetName)}`);
tool('pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', targetName, temporaryBackup);
const restoreSeconds = (Date.now() - start) / 1000;
const restored = counts(targetName);
const after = counts(sourceName);
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('SOURCE_WRITERS_ACTIVE: counts changed during the drill; retain artifacts and rerun with writers stopped');
if (JSON.stringify(before) !== JSON.stringify(restored)) throw new Error('RESTORED_COUNTS_DIFFER');
if (sourceSchema !== sql(targetName, schemaQuery)) throw new Error('RESTORED_SCHEMA_DIFFERS');
const targetUrl = new URL(source); targetUrl.pathname = `/${targetName}`;
run(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'status'], { ...process.env, DATABASE_URL: targetUrl.toString(), TEMP: resolve('.tmp'), TMP: resolve('.tmp') });
const migrations = JSON.parse(sql(targetName, `SELECT json_agg(migration_name ORDER BY migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)) as string[];
if (JSON.stringify(migrations) !== JSON.stringify(readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())) throw new Error('MIGRATIONS_DIFFER');
const integrity = JSON.parse(sql(targetName, integrityQuery)) as Record<string, number>;
const report = { checkedAt: new Date().toISOString(), tooling: version, targetDatabase: targetName, backupBytes: statSync(backup).size, sha256: checksum, readable: true, restoreSeconds, verificationSeconds: (Date.now() - start) / 1000, schemaMatches: true, foreignKeysValidatedDuringRestore: true, migrations: migrations.length, counts: restored, integrity, status: Object.values(integrity).every(count => count === 0) ? 'VERIFIED' : 'FAILED' };
writeFileSync(`${backup}.verification.json`, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'VERIFIED') process.exitCode = 1;
