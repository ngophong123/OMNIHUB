import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import type { Context } from '../../auth';
import { parseUuid } from '../../shared/http-helpers';

export async function resolveKitchenDevice(
  database: PrismaClient,
  req: Request,
  ctx: Context,
  required: boolean,
) {
  const raw = req.get('X-Kitchen-Device');
  if (!raw) {
    if (required) throw new ForbiddenException('KITCHEN_DEVICE_REQUIRED');
    return undefined;
  }
  const device = await database.kitchenDevice.findFirst({
    where: {
      id: parseUuid(raw),
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      revokedAt: null,
    },
    select: { id: true, stationId: true },
  });
  if (!device) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
  return device;
}

export async function auditKitchenDevice(
  database: PrismaClient,
  ctx: Context,
  id: string,
  action: string,
  details?: Record<string, unknown>,
) {
  await database.audit.create({
    data: {
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      actorId: ctx.userId,
      action,
      entityId: id,
      commandKey: `kitchen-device:${action}:${randomUUID()}`,
      correlationId: ctx.correlationId,
      ...(details ? { details: details as Prisma.InputJsonValue } : {}),
    },
  });
}

export async function updateAuthorizedKitchenDeviceHeartbeat(
  tx: Prisma.TransactionClient,
  current: { tenantId: string; storeId: string; userId: string },
  deviceId: string,
): Promise<boolean> {
  const updated = await tx.kitchenDevice.updateMany({
    where: {
      id: deviceId,
      tenantId: current.tenantId,
      storeId: current.storeId,
      userId: current.userId,
      revokedAt: null,
    },
    data: { lastSeenAt: new Date() },
  });
  if (updated.count === 1) return true;
  const existing = await tx.kitchenDevice.findUnique({ where: { id: deviceId }, select: { id: true } });
  if (existing) throw new ForbiddenException('KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE');
  return false;
}
