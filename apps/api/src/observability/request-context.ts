import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogCategory = 'application' | 'security' | 'operational';

export type ExecutionContext = {
  correlationId: string;
  service: string;
  component?: string;
  tenantId?: string;
  storeId?: string;
  userId?: string;
  jobName?: string;
  batchId?: string;
};

const SAFE_CORRELATION_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const contextStorage = new AsyncLocalStorage<ExecutionContext>();

/** Returns true when raw is a bounded, single-line correlation identifier safe for logs and headers. */
export function isValidCorrelationId(raw: unknown): raw is string {
  return typeof raw === 'string' && SAFE_CORRELATION_ID_RE.test(raw.trim());
}

/** Validates client/proxy correlation IDs and falls back to a fresh UUID v4 to block log injection. */
export function resolveCorrelationId(raw?: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (SAFE_CORRELATION_ID_RE.test(trimmed)) return trimmed;
  }
  return randomUUID();
}

/** Executes a callback inside an isolated AsyncLocalStorage logging context. */
export function runWithLogContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return contextStorage.run({ ...ctx }, fn);
}

/** Returns the active AsyncLocalStorage execution context, if inside a tracked scope. */
export function getLogContext(): ExecutionContext | undefined {
  return contextStorage.getStore();
}

/** Enriches the active execution context (e.g. tenant/store/user after authentication). */
export function updateLogContext(patch: Partial<ExecutionContext>): void {
  const store = contextStorage.getStore();
  if (!store) return;
  if (patch.correlationId !== undefined) store.correlationId = patch.correlationId;
  if (patch.service !== undefined) store.service = patch.service;
  if (patch.component !== undefined) store.component = patch.component;
  if (patch.tenantId !== undefined) store.tenantId = patch.tenantId;
  if (patch.storeId !== undefined) store.storeId = patch.storeId;
  if (patch.userId !== undefined) store.userId = patch.userId;
  if (patch.jobName !== undefined) store.jobName = patch.jobName;
  if (patch.batchId !== undefined) store.batchId = patch.batchId;
}
