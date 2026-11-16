import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { EventType } from '@omnihub/contracts';
import { allowed, digest, type Permission } from './domain';
import { reauthorize, type Context } from './auth';
import { apiMetrics } from './observability/metrics';
export type Tx = Prisma.TransactionClient;
export type Result = { id: string; version: number };
export const scope = (c: Context) => ({ tenantId: c.tenantId, storeId: c.storeId });
export function requirePermission(c: Context, p: Permission) { if (!allowed(c.role, p)) throw new ForbiddenException('PERMISSION_DENIED'); }

export class CommandBus {
  constructor(protected readonly db: PrismaClient) {}
  private recordCommandSuccess(operation: EventType, isReplay: boolean): void {
    apiMetrics.recordCommandBusAttempt(operation, isReplay ? 'idempotent_replay' : 'success');
  }
  private recordCommandFailure(operation: EventType, error: unknown, isRetryable: boolean, exhausted: boolean): void {
    const known = error instanceof Prisma.PrismaClientKnownRequestError;
    if (known) apiMetrics.recordDbError(error.code);
    if (!isRetryable) {
      apiMetrics.recordCommandBusAttempt(operation, 'error');
      return;
    }
    const reason = known && error.code === 'P2034'
      ? 'p2034_serialization'
      : known && error.code === 'P2002'
        ? 'p2002_unique'
        : 'pg_transient_retry';
    apiMetrics.recordDbRetry(operation, reason);
    const outcome = exhausted
      ? 'conflict_exhausted'
      : reason === 'p2034_serialization'
        ? 'retry_p2034'
        : reason === 'p2002_unique'
          ? 'retry_p2002'
          : 'retry_transient';
    apiMetrics.recordCommandBusAttempt(operation, outcome);
  }
  protected async command(ctx: Context, key: string, operation: EventType, payload: unknown, work: (tx: Tx, current: Context) => Promise<Result>, permission: Permission): Promise<Result> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)) throw new BadRequestException('IDEMPOTENCY_KEY_UUID_V4_REQUIRED');
    const hash = digest(JSON.stringify({ actor: ctx.userId, operation, payload }));
    for (let attempt = 0; attempt < 4; attempt++) {
      let replayed = false;
      try {
        const out = await this.db.$transaction(async tx => {
          const current = await reauthorize(tx, ctx); requirePermission(current, permission);
          const receipt = await tx.commandReceipt.findUnique({ where: { tenantId_storeId_key: { ...scope(ctx), key } } });
          if (receipt) {
            if (receipt.hash !== hash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
            replayed = true;
            return receipt.response as Result;
          }
          const result = await work(tx, current);
          await tx.audit.create({ data: { ...scope(ctx), actorId: ctx.userId, action: operation, entityId: result.id, commandKey: key, correlationId: ctx.correlationId, details: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue } });
          await tx.outbox.create({ data: { ...scope(ctx), type: operation, aggregateId: result.id, version: result.version, correlationId: ctx.correlationId } });
          await tx.commandReceipt.create({ data: { ...scope(ctx), key, hash, response: result } });
          return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
        this.recordCommandSuccess(operation, replayed);
        return out;
      } catch (error) {
        const known = error instanceof Prisma.PrismaClientKnownRequestError;
        if (known && error.code === 'P2002' && JSON.stringify(error.meta?.target ?? '').toLowerCase().includes('externalreference')) {
          this.recordCommandFailure(operation, error, false, false);
          throw new ConflictException('DUPLICATE_PAYMENT_REFERENCE');
        }
        const transientRaw = known && error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code));
        if (known && (error.code === 'P2034' || error.code === 'P2002' || transientRaw)) {
          this.recordCommandFailure(operation, error, true, attempt === 3);
          if (attempt === 3) throw new ConflictException('CONCURRENT_CHANGE_RETRY_SAME_KEY');
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1))); continue;
        }
        this.recordCommandFailure(operation, error, false, false);
        throw error;
      }
    }
    throw new ConflictException('RETRY_EXHAUSTED');
  }

  /** Public customer capabilities use a separate hashed bearer token and are revalidated by work in the same transaction. */
  protected async publicCommand(ctx: Context, key: string, operation: EventType, payload: unknown, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)) throw new BadRequestException('IDEMPOTENCY_KEY_UUID_V4_REQUIRED');
    const hash = digest(JSON.stringify({ actor: ctx.userId, operation, payload }));
    for (let attempt = 0; attempt < 4; attempt++) {
      let replayed = false;
      try {
        const out = await this.db.$transaction(async tx => {
          const receipt = await tx.commandReceipt.findUnique({ where: { tenantId_storeId_key: { ...scope(ctx), key } } });
          if (receipt) {
            if (receipt.hash !== hash) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
            replayed = true;
            return receipt.response as Result;
          }
          const result = await work(tx);
          await tx.audit.create({ data: { ...scope(ctx), actorId: ctx.userId, action: operation, entityId: result.id, commandKey: key, correlationId: ctx.correlationId, details: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue } });
          await tx.outbox.create({ data: { ...scope(ctx), type: operation, aggregateId: result.id, version: result.version, correlationId: ctx.correlationId } });
          await tx.commandReceipt.create({ data: { ...scope(ctx), key, hash, response: result } });
          return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 15000 });
        this.recordCommandSuccess(operation, replayed);
        return out;
      } catch (error) {
        const known = error instanceof Prisma.PrismaClientKnownRequestError;
        const transientRaw = known && error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code));
        if (known && (error.code === 'P2034' || error.code === 'P2002' || transientRaw)) {
          this.recordCommandFailure(operation, error, true, attempt === 3);
          if (attempt === 3) throw new ConflictException('CONCURRENT_CHANGE_RETRY_SAME_KEY');
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1))); continue;
        }
        this.recordCommandFailure(operation, error, false, false);
        throw error;
      }
    }
    throw new ConflictException('RETRY_EXHAUSTED');
  }
}
