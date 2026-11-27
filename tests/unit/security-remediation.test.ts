import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readFdBytesForTest(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

describe('security remediation script invariants', () => {
  it('verify-container-backup reads and hashes backup bytes from the opened file descriptor without statSync/readFileSync TOCTOU', () => {
    const source = readFileSync(resolve('scripts/verify-container-backup.ts'), 'utf8');
    expect(source).not.toMatch(/\bstatSync\b/);
    expect(source).not.toMatch(/\breadFileSync\b/);
    expect(source).toContain("openSync(backup, 'wx+', 0o600)");
    expect(source).toContain('readFdBytes(backupFd)');
    expect(source).toContain("if (backupBytes.length === 0) throw new Error('EMPTY_BACKUP')");
    expect(source).toContain("createHash('sha256').update(backupBytes).digest('hex')");
    expect(source).toContain("if (checksum !== containerChecksum) throw new Error('BACKUP_CHECKSUM_MISMATCH')");

    // Behavioral check of the single-fd wx+ write-then-read-and-hash pattern.
    const dir = mkdtempSync(join(tmpdir(), 'omnihub-fd-test-'));
    try {
      const payload = Buffer.from(`backup-${randomUUID()}-`.repeat(5000));
      const file = join(dir, 'sample.dump');
      const fd = openSync(file, 'wx+', 0o600);
      let readBack: Buffer;
      try {
        writeSync(fd, payload);
        readBack = readFdBytesForTest(fd);
      } finally {
        closeSync(fd);
      }
      expect(readBack.length).toBe(payload.length);
      expect(createHash('sha256').update(readBack).digest('hex')).toBe(
        createHash('sha256').update(payload).digest('hex'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('staging-drills uses static Prisma scripts and environment-passed UUID instead of dynamic JS code interpolation', () => {
    const source = readFileSync(resolve('scripts/staging-drills.ts'), 'utf8');
    expect(source).not.toMatch(/function\s+db\s*</);
    expect(source).not.toMatch(/\$\{JSON\.stringify\(fixture\.userId\)\}/);
    expect(source).toContain('CREATE_DRILL_FIXTURE_SCRIPT');
    expect(source).toContain('EXPIRE_DRILL_SESSIONS_SCRIPT');
    expect(source).toContain('DRILL_USER_ID=');
    expect(source).toContain('process.env.DRILL_USER_ID');
    expect(source).toContain("if (!UUID_RE.test(userId)) throw new Error('INVALID_DRILL_USER_ID')");
    // Alert #2 staging TLS login test remains intact.
    expect(source).toContain('https://localhost:8444${path}');
    expect(source).toContain("readFileSync('.local/staging/secrets/demo_password', 'utf8').trim()");
  });
});
