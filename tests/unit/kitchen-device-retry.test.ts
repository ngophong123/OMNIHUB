import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SERIALIZABLE_MAX_ATTEMPTS,
  isPrismaSerializationConflict,
  runSerializableTransactionWithRetry,
  type SerializableTxClient,
} from '../../apps/api/src/database';

function prismaKnownError(code: string, message = `Prisma error ${code}`): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '6.19.0',
  });
}

class TestHttpException extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

describe('Serializable transaction retry helper', () => {
  it('detects only Prisma P2034 serialization conflicts', () => {
    expect(isPrismaSerializationConflict(prismaKnownError('P2034'))).toBe(true);
    expect(isPrismaSerializationConflict(prismaKnownError('P2002'))).toBe(false);
    expect(isPrismaSerializationConflict(prismaKnownError('P2025'))).toBe(false);
    expect(isPrismaSerializationConflict(new TestHttpException(409, 'CONCURRENCY_CONFLICT'))).toBe(false);
    expect(isPrismaSerializationConflict(new Error('P2034'))).toBe(false);
  });

  it('retries P2034 conflicts up to 3 attempts, re-runs full callback with bounded backoff, and succeeds', async () => {
    const callbacksRun: number[] = [];
    const delays: number[] = [];
    const txOptionsSeen: unknown[] = [];

    const client: SerializableTxClient = {
      async $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown): Promise<T> {
        txOptionsSeen.push(options);
        const attempt = txOptionsSeen.length;
        const result = await fn({ attempt } as unknown as Prisma.TransactionClient);
        if (attempt < 3) {
          throw prismaKnownError('P2034', 'could not serialize access due to concurrent update');
        }
        return result;
      },
    };

    const reauthorizeSpy = vi.fn(async (attempt: number) => ({ userId: 'u1', attempt }));

    const output = await runSerializableTransactionWithRetry(
      client,
      async tx => {
        const currentAttempt = (tx as unknown as { attempt: number }).attempt;
        callbacksRun.push(currentAttempt);
        const current = await reauthorizeSpy(currentAttempt);
        return { ok: true, current };
      },
      {
        operation: 'kitchen.device.changed',
        baseDelayMs: 10,
        maxDelayMs: 50,
        sleep: async ms => {
          delays.push(ms);
        },
      },
    );

    expect(output).toEqual({ ok: true, current: { userId: 'u1', attempt: 3 } });
    expect(txOptionsSeen).toHaveLength(DEFAULT_SERIALIZABLE_MAX_ATTEMPTS);
    expect(txOptionsSeen).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 15_000 },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 15_000 },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 15_000 },
    ]);
    expect(callbacksRun).toEqual([1, 2, 3]);
    expect(reauthorizeSpy).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThanOrEqual(50);
    }
  });

  it('stops after 3 attempts and rethrows the real P2034 error without masking it', async () => {
    const p2034 = prismaKnownError('P2034', 'could not serialize access due to concurrent update');
    let calls = 0;
    const sleep = vi.fn(async () => undefined);

    const client: SerializableTxClient = {
      async $transaction<T>(): Promise<T> {
        calls += 1;
        throw p2034;
      },
    };

    await expect(
      runSerializableTransactionWithRetry(client, async () => 'never', {
        operation: 'kitchen.device.changed',
        maxAttempts: 5, // capped cleanly at DEFAULT_SERIALIZABLE_MAX_ATTEMPTS (3)
        baseDelayMs: 5,
        maxDelayMs: 20,
        sleep,
      }),
    ).rejects.toBe(p2034);

    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry 401, 403, 404, 409, or non-P2034 Prisma/runtime errors', async () => {
    const nonRetryableErrors: unknown[] = [
      new TestHttpException(401, 'SESSION_REVOKED'),
      new TestHttpException(403, 'KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE'),
      new TestHttpException(404, 'KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED'),
      new TestHttpException(409, 'KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED'),
      prismaKnownError('P2002'),
      prismaKnownError('P2025'),
      new Error('UNEXPECTED_DB_ERROR'),
    ];

    for (const expectedError of nonRetryableErrors) {
      let calls = 0;
      const sleep = vi.fn(async () => undefined);
      const client: SerializableTxClient = {
        async $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
          calls += 1;
          return fn({} as Prisma.TransactionClient);
        },
      };

      await expect(
        runSerializableTransactionWithRetry(
          client,
          async () => {
            throw expectedError;
          },
          { sleep },
        ),
      ).rejects.toBe(expectedError);

      expect(calls).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });
});
