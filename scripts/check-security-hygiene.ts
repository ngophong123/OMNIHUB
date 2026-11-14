import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Violation = { file: string; line?: number; rule: string };

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;
const HIGH_CONFIDENCE_TOKEN_PATTERNS: { rule: string; regex: RegExp }[] = [
  { rule: 'GitHub classic personal access token', regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { rule: 'GitHub fine-grained access token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { rule: 'AWS access key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'Slack token prefix', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'Live Stripe secret key', regex: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  {
    rule: 'Non-local embedded database or Redis credential',
    regex: /(?:postgres(?:ql)?|redis):\/\/(?!omnihub:omnihub@|postgres:postgres@)[^:@\s'"`]+:[^@\s'"`]+@(?!localhost\b|127\.0\.0\.1\b|postgres\b|redis\b)/i,
  },
];

const FORBIDDEN_TRACKED_PATHS: { rule: string; regex: RegExp }[] = [
  { rule: 'Committed environment file', regex: /(?:^|\/)\.env(?:\.(?!example$).+)?$/i },
  { rule: 'Committed private key or certificate bundle', regex: /\.(?:pem|key|p12|pfx|jks)$/i },
  { rule: 'Committed local runtime or artifact directory', regex: /^(?:\.local|\.tmp|coverage|playwright-report|test-results)\//i },
];

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const violations: Violation[] = [];

for (const file of trackedFiles) {
  for (const { rule, regex } of FORBIDDEN_TRACKED_PATHS) {
    if (regex.test(file)) {
      violations.push({ file, rule });
    }
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }

  // Skip binary files while scanning all source, config, workflow, and docs files.
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');
  const lines = content.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (PRIVATE_KEY_RE.test(line)) {
      violations.push({ file, line: idx + 1, rule: 'PEM private key header' });
    }
    if (file === 'scripts/check-security-hygiene.ts') continue;
    for (const { rule, regex } of HIGH_CONFIDENCE_TOKEN_PATTERNS) {
      if (regex.test(line)) {
        violations.push({ file, line: idx + 1, rule });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Security hygiene check failed (${violations.length} violation(s)):`);
  for (const v of violations) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    console.error(`- ${loc} [${v.rule}]`);
  }
  process.exitCode = 1;
} else {
  console.log(`Scanned ${trackedFiles.length} tracked files: 0 security hygiene violations found.`);
}
