import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const API_PORT = process.env.PORT ?? '4000';
const READY_URL = process.env.API_READY_URL ?? `http://127.0.0.1:${API_PORT}/ready`;
const WEB_BASE = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3000';
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next', { paths: [path.resolve('apps/web')] });

type ManagedService = { name: string; child: ChildProcess; exitInfo?: string };

function prefixLines(name: string, chunk: Buffer, stream: NodeJS.WriteStream) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) stream.write(`[${name}] ${line}\n`);
  }
}

function startService(name: string, command: string, args: string[], cwd?: string): ManagedService {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: process.platform !== 'win32',
  });
  const service: ManagedService = { name, child };
  child.stdout?.on('data', chunk => prefixLines(name, chunk, process.stdout));
  child.stderr?.on('data', chunk => prefixLines(name, chunk, process.stderr));
  child.on('exit', (code, signal) => {
    service.exitInfo = `${name} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
  });
  return service;
}

async function waitForHttpReady(url: string, services: ManagedService[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const service of services) {
      if (service.exitInfo) throw new Error(service.exitInfo);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return;
    } catch {
      // Service still booting; retry until deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for readiness check at ${url}`);
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

async function main() {
  const services: ManagedService[] = [];
  try {
    console.log('[e2e-ci] Starting api, worker, and web services...');
    services.push(startService('api', process.execPath, ['apps/api/dist/main.js']));
    services.push(startService('worker', process.execPath, ['apps/api/dist/worker.js']));
    services.push(startService('web', process.execPath, [nextBin, 'start', '--hostname', '0.0.0.0'], path.resolve('apps/web')));

    await waitForHttpReady(READY_URL, services);
    await waitForHttpReady(WEB_BASE, services);
    console.log('[e2e-ci] Services ready; launching Playwright suite...');

    const exitCode = await runPlaywright();
    console.log(`[e2e-ci] Playwright exited with code ${exitCode}.`);
    process.exitCode = exitCode;
  } finally {
    await stopServices(services);
    console.log('[e2e-ci] Services stopped.');
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
