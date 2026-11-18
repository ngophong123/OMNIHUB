import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { apiMetrics } from './observability/metrics';

config({ path: resolve(__dirname, '../../../.env'), quiet: true });
export const db = new PrismaClient();

export const DEFAULT_SERIALIZABLE_MAX_ATTEMPTS = 3;
export const DEFAULT_SERIALIZABLE_BASE_DELAY_MS = 15;
export const DEFAULT_SERIALIZABLE_MAX_DELAY_MS = 75;

export type SerializableTxClient = {
  $transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number },
  ): Promise<T>;
};

export type SerializableRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  operation?: string;
  sleep?: (ms: number) => Promise<void>;
};

/** Returns true only for Prisma P2034 (PostgreSQL SQLSTATE 40001 serialization conflict). */
export function isPrismaSerializationConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

/**
 * Executes a Prisma Serializable transaction with bounded retry strictly on P2034 conflicts,
 * re-running the entire transaction callback (including reauthorize) on each attempt.
 */
export async function runSerializableTransactionWithRetry<T>(
  client: SerializableTxClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const rawAttempts = options.maxAttempts ?? DEFAULT_SERIALIZABLE_MAX_ATTEMPTS;
  const maxAttempts = Number.isInteger(rawAttempts) && rawAttempts >= 1
    ? Math.min(rawAttempts, DEFAULT_SERIALIZABLE_MAX_ATTEMPTS)
    : DEFAULT_SERIALIZABLE_MAX_ATTEMPTS;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_SERIALIZABLE_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_SERIALIZABLE_MAX_DELAY_MS);
  const sleepFn = options.sleep ?? defaultSleep;
  const operation = options.operation ?? 'other';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.$transaction(tx => work(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (error) {
      if (!isPrismaSerializationConflict(error)) {
        throw error;
      }
      apiMetrics.recordDbError('P2034');
      if (attempt >= maxAttempts) {
        throw error;
      }
      apiMetrics.recordDbRetry(operation, 'p2034_serialization');
      const backoff = Math.min(maxDelayMs, baseDelayMs * attempt + Math.floor(Math.random() * (baseDelayMs + 1)));
      if (backoff > 0) {
        await sleepFn(backoff);
      }
    }
  }
  throw new Error('SERIALIZABLE_RETRY_UNREACHABLE');
}
