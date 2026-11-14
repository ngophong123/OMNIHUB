import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Optional real PostgreSQL for local development; does not modify system services.
// Fixed credentials belong only to this loopback-only developer database.
const databaseDir = resolve('.local/postgres');
mkdirSync(resolve('.local'), { recursive: true });
const pg = new EmbeddedPostgres({ databaseDir, user: 'omnihub', password: 'local_only_change_me', port: 5432, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => undefined });
async function start() {
  if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname='omnihub'");
  await client.end();
  if (!result.rowCount) await pg.createDatabase('omnihub');
  console.log('Local PostgreSQL ready on 127.0.0.1:5432. Data: .local/postgres. Ctrl+C stops the server.');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await pg.stop(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  setInterval(() => undefined, 30_000);
}
void start().catch(error => { console.error(error); process.exit(1); });
