import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Create only missing secrets. Never rotate credentials for an existing volume.
async function main() {
const directory = resolve('.local/staging/secrets');
await mkdir(directory, { recursive: true });
for (const name of ['db_admin_password', 'db_owner_password', 'db_app_password', 'db_backup_password', 'redis_password', 'qr_secret', 'demo_password', 'backup_password']) {
  try { await writeFile(resolve(directory, name), randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
if (process.platform === 'win32') {
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv'], { encoding: 'utf8' }).match(/S-1-5-[\d-]+/)?.[0];
  if (!sid) throw new Error('WINDOWS_ACCOUNT_SID_REQUIRED');
  // Restrict only this staging secret subtree. The parent workspace and all
  // development data retain their ACLs. No generated credential is rotated.
  const harden = (path: string, folder: boolean) => {
    const inherit = folder ? '(OI)(CI)' : '';
    // Grant the owner explicitly *before* removing inheritance. Otherwise a
    // recursive ACL rewrite can lose traversal permission halfway through.
    execFileSync('icacls', [path, '/grant:r', `*${sid}:${inherit}F`], { stdio: 'ignore' });
    execFileSync('icacls', [path, '/inheritance:r'], { stdio: 'ignore' });
    execFileSync('icacls', [path, '/grant:r', `*S-1-5-18:${inherit}F`, `*S-1-5-32-544:${inherit}F`], { stdio: 'ignore' });
  };
  const hardenTree = async (root: string) => {
    harden(root, true);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('PRIVATE_ARTIFACT_SYMLINK_NOT_ALLOWED');
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) await hardenTree(path);
      else if (entry.isFile()) harden(path, false);
      else throw new Error('PRIVATE_ARTIFACT_TYPE_NOT_ALLOWED');
    }
  };
  await hardenTree(resolve('.local/staging'));
  await hardenTree(resolve('.local/backups'));
}
console.log('Local staging secret files prepared and restricted; existing secrets preserved.');
}
void main();
