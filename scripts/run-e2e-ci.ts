import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const API_PORT = process.env.PORT ?? '4000';
const READY_URL = process.env.API_READY_URL ?? `http://127.0.0.1:${API_PORT}/ready`;
const WEB_PORT = process.env.WEB_PORT ?? '3000';
const WEB_BASE = process.env.E2E_WEB_ORIGIN ?? `http://localhost:${WEB_PORT}`;
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next', { paths: [path.resolve('apps/web')] });

type ManagedService = { name: string; child: ChildProcess; exitInfo?: string; recentErr: string[] };

function prefixLines(service: ManagedService, chunk: Buffer, stream: NodeJS.WriteStream, isErr: boolean) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    stream.write(`[${service.name}] ${line}\n`);
    if (isErr) {
      service.recentErr.push(line);
      if (service.recentErr.length > 5) service.recentErr.shift();
    }
  }
}

function startService(name: string, command: string, args: string[], cwd?: string): ManagedService {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: process.platform !== 'win32',
  });
  const service: ManagedService = { name, child, recentErr: [] };
  child.stdout?.on('data', chunk => prefixLines(service, chunk, process.stdout, false));
  child.stderr?.on('data', chunk => prefixLines(service, chunk, process.stderr, true));
  child.on('exit', (code, signal) => {
    service.exitInfo = `${name} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  });
  return service;
}

async function waitForHttpReady(url: string, services: ManagedService[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    for (const service of services) {
      if (service.exitInfo) throw new Error(`${service.exitInfo} stderr=[${service.recentErr.join(' | ')}]`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const errTail = services.map(s => (s.recentErr.length ? `${s.name}:[${s.recentErr.join(' | ')}]` : '')).filter(Boolean).join('; ');
  throw new Error(`Timed out waiting for readiness check at ${url} (lastStatus=${lastStatus ?? 'none'}, lastError=${lastError ?? 'none'}${errTail ? `, stderr=${errTail}` : ''})`);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function stopServices(services: ManagedService[]) {
  await Promise.all(
    services.map(
      ({ child }) =>
        new Promise<void>(resolve => {
          const finalize = () => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve();
          };
          if (child.exitCode !== null || child.signalCode !== null) {
            finalize();
            return;
          }
          const timer = setTimeout(() => {
            signalProcessTree(child, 'SIGKILL');
            finalize();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            finalize();
          });
          signalProcessTree(child, 'SIGTERM');
        }),
    ),
  );
}

async function runPlaywright(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pnpmCmd, ['exec', 'playwright', 'test'], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') resolve(code);
      else reject(new Error(`playwright terminated with signal ${signal ?? 'unknown'}`));
    });
  });
}

type JsonSuite = {
  title?: string;
  specs?: {
    title?: string;
    ok?: boolean;
    tests?: { results?: { status?: string; error?: { message?: string; stack?: string } }[] }[];
  }[];
  suites?: JsonSuite[];
};

function sanitizeMessage(text: string): string {
  const secret = process.env.DEMO_PASSWORD;
  const redacted = secret ? text.split(secret).join('[REDACTED]') : text;
  return stripVTControlCharacters(redacted).replace(/\r?\n+/g, ' ').trim().slice(0, 350);
}

function reportPlaywrightFailures() {
  const reportPath = path.resolve('test-results/results.json');
  if (!existsSync(reportPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as { suites?: JsonSuite[] };
    const walk = (suites: JsonSuite[], prefix: string[]) => {
      for (const suite of suites) {
        const nextPrefix = suite.title ? [...prefix, suite.title] : prefix;
        for (const spec of suite.specs ?? []) {
          if (spec.ok) continue;
          const failedResult = spec.tests?.flatMap(t => t.results ?? []).find(r => r.status && r.status !== 'passed' && r.status !== 'skipped');
          const raw = failedResult?.error?.message ?? failedResult?.error?.stack ?? `status=${failedResult?.status ?? 'failed'}`;
          const line = `[Playwright FAILED] ${[...nextPrefix, spec.title ?? 'unknown'].join(' > ')}: ${sanitizeMessage(raw)}`;
          console.error(line);
          if (process.env.GITHUB_ACTIONS === 'true') {
            console.log(`::error::${line}`);
          }
        }
        if (suite.suites?.length) walk(suite.suites, nextPrefix);
      }
    };
    walk(parsed.suites ?? [], []);
  } catch (error) {
    console.error('Could not parse Playwright JSON report:', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const services: ManagedService[] = [];
  try {
    console.log('[e2e-ci] Starting api, worker, and web services...');
    services.push(startService('api', process.execPath, ['apps/api/dist/main.js']));
    services.push(startService('worker', process.execPath, ['apps/api/dist/worker.js']));
    services.push(startService('web', process.execPath, [nextBin, 'start', '--port', WEB_PORT], path.resolve('apps/web')));

    await waitForHttpReady(READY_URL, services);
    await waitForHttpReady(WEB_BASE, services);
    console.log('[e2e-ci] Services ready; launching Playwright suite...');

    const exitCode = await runPlaywright();
    console.log(`[e2e-ci] Playwright exited with code ${exitCode}.`);
    if (exitCode !== 0) reportPlaywrightFailures();
    process.exitCode = exitCode;
  } finally {
    await stopServices(services);
    console.log('[e2e-ci] Services stopped.');
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error::${message.replace(/\r?\n/g, ' ')}`);
  }
  process.exitCode = 1;
});
