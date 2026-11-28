import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { authenticate, type Context } from '../auth';
import { getLogContext } from '../observability/request-context';
import { publishRealtimeOperationalEvent } from '../realtime';

export const HEX64_RE = /^[a-f0-9]{64}$/i;

export function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('INVALID_INPUT');
  return result.data;
}

export function parseUuid(id: string): string {
  return parseInput(z.string().uuid(), id);
}

export function requestCorrelationId(req: Request): string {
  return String(req.res?.getHeader('x-correlation-id') ?? getLogContext()?.correlationId ?? '');
}

export function authenticateRequest(database: PrismaClient, req: Request): Promise<Context> {
  const sessionCookie = typeof req.cookies?.session === 'string' ? req.cookies.session : undefined;
  return authenticate(database, sessionCookie, requestCorrelationId(req));
}

export function idempotencyKey(req: Request): string {
  return req.get('Idempotency-Key') ?? '';
}

export function extractBearerToken64(req: Request): string | undefined {
  return req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
}

export function publishOutboxRevocation(
  row: { id: string; tenantId: string; storeId: string; aggregateId: string; version: number; createdAt: Date },
  type: 'session.revoked' | 'kitchen.device.changed',
): void {
  void publishRealtimeOperationalEvent({
    eventId: row.id,
    schemaVersion: 1,
    tenantId: row.tenantId,
    storeId: row.storeId,
    type,
    aggregateId: row.aggregateId,
    version: row.version,
    occurredAt: row.createdAt.toISOString(),
  });
}
