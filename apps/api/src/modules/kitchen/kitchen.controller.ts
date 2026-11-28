import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { kitchenDeviceAssignmentSchema, kitchenDeviceSchema, kitchenSyncSchema } from '@omnihub/contracts';
import { reauthorize } from '../../auth';
import { runSerializableTransactionWithRetry } from '../../database';
import { allowed } from '../../domain';
import { Operations } from '../../operations';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, parseInput, parseUuid, publishOutboxRevocation } from '../../shared/http-helpers';
import { auditKitchenDevice, updateAuthorizedKitchenDeviceHeartbeat } from './kitchen-device.helper';

@Controller()
export class KitchenController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(Operations) private readonly ops: Operations,
  ) {}

  @Post('kitchen/devices/register')
  async registerKitchenDevice(@Req() req: Request, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    const { deviceId } = parseInput(kitchenDeviceSchema, body);
    if (!allowed(c.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
    // Heartbeats use an atomic conditional ReadCommitted update (revokedAt IS NULL) so concurrent
    // heartbeats serialize on the row lock via PostgreSQL EvalPlanQual without P2034 aborts.
    const touched = await this.db.$transaction(
      async tx => {
        const current = await reauthorize(tx, c);
        if (!allowed(current.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
        return updateAuthorizedKitchenDeviceHeartbeat(tx, current, deviceId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 },
    );

    if (!touched) {
      await runSerializableTransactionWithRetry(
        this.db,
        async tx => {
          const current = await reauthorize(tx, c);
          if (!allowed(current.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
          if (await updateAuthorizedKitchenDeviceHeartbeat(tx, current, deviceId)) return;
          await tx.kitchenDevice.create({
            data: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, userId: current.userId },
          });
          await tx.audit.create({
            data: {
              tenantId: current.tenantId,
              storeId: current.storeId,
              actorId: current.userId,
              action: 'KITCHEN_DEVICE_REGISTERED',
              entityId: deviceId,
              commandKey: `kitchen-device:KITCHEN_DEVICE_REGISTERED:${randomUUID()}`,
              correlationId: current.correlationId,
            },
          });
        },
        { operation: 'kitchen.device.changed' },
      );
    }
    return { deviceId, authorized: true };
  }

  @Post('kitchen/sync')
  async syncKitchenCommands(@Req() req: Request, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    const { commands } = parseInput(kitchenSyncSchema, body);
    if (!allowed(c.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
    if (
      commands.some(
        command => command.tenantId !== c.tenantId || command.storeId !== c.storeId || command.userId !== c.userId,
      ) ||
      new Set(commands.map(command => command.commandId)).size !== commands.length ||
      new Set(commands.map(command => command.sequence)).size !== commands.length ||
      commands.some((command, index) => index > 0 && command.sequence <= commands[index - 1]!.sequence)
    ) {
      throw new BadRequestException('INVALID_REPLAY_SCOPE_OR_ORDER');
    }
    const deviceIds = new Set(commands.map(command => command.deviceId));
    if (deviceIds.size > 1) throw new BadRequestException('MULTIPLE_REPLAY_DEVICES');
    let device: { id: string; stationId: string | null } | null = null;
    if (commands.length) {
      const headerDeviceId = req.get('X-Kitchen-Device');
      if (headerDeviceId !== commands[0]!.deviceId) throw new ForbiddenException('KITCHEN_DEVICE_HEADER_MISMATCH');
      device = await this.db.kitchenDevice.findFirst({
        where: {
          id: commands[0]!.deviceId,
          tenantId: c.tenantId,
          storeId: c.storeId,
          userId: c.userId,
          revokedAt: null,
        },
        select: { id: true, stationId: true },
      });
      if (!device) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
      const touched = await this.db.kitchenDevice.updateMany({
        where: { id: device.id, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null },
        data: { lastSeenAt: new Date() },
      });
      if (touched.count !== 1) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
    }
    const blockedOrders = new Set<string>();
    const results: { commandId: string; status: 'CONFIRMED' | 'CONFLICT' | 'REJECTED' | 'BLOCKED'; version?: number; code?: string }[] = [];
    for (const command of commands) {
      if (blockedOrders.has(command.orderId)) {
        results.push({ commandId: command.commandId, status: 'BLOCKED', code: 'PREVIOUS_COMMAND_CONFLICT' });
        continue;
      }
      try {
        const created = Date.parse(command.createdAt);
        if (!Number.isFinite(created) || created > Date.now() + 5 * 60_000 || created < Date.now() - 30 * 24 * 60 * 60_000) {
          throw new ConflictException('OFFLINE_COMMAND_EXPIRED');
        }
        const item = await this.db.orderItem.findFirst({
          where: {
            tenantId: c.tenantId,
            storeId: c.storeId,
            id: command.itemId,
            ...(device?.stationId ? { ticket: { stationId: device.stationId } } : {}),
          },
          select: { orderId: true },
        });
        if (!item || item.orderId !== command.orderId) throw new ForbiddenException('KITCHEN_COMMAND_SCOPE_MISMATCH');
        const result = await this.ops.item(
          c,
          command.commandId,
          command.itemId,
          { action: command.action, expectedVersion: command.expectedVersion },
          { kitchenDeviceId: device!.id },
        );
        results.push({ commandId: command.commandId, status: 'CONFIRMED', version: result.version });
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() >= 500) throw error;
        if (error instanceof HttpException && error.getStatus() === 401) throw error;
        if (error instanceof HttpException && error.message === 'KITCHEN_DEVICE_NOT_AUTHORIZED') throw error;
        const conflict = error instanceof HttpException && error.getStatus() === 409;
        const code = error instanceof HttpException ? error.message : 'COMMAND_REJECTED';
        results.push({ commandId: command.commandId, status: conflict ? 'CONFLICT' : 'REJECTED', code });
        blockedOrders.add(command.orderId);
      }
    }
    if (commands.length) {
      await auditKitchenDevice(this.db, c, commands[0]!.deviceId, 'KITCHEN_DEVICE_SYNCED', {
        count: commands.length,
        confirmed: results.filter(row => row.status === 'CONFIRMED').length,
        rejected: results.filter(row => row.status === 'REJECTED' || row.status === 'CONFLICT' || row.status === 'BLOCKED').length,
      });
    }
    return { results };
  }

  @Get('admin/kitchen/devices')
  async listKitchenDevices(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const devices = await this.db.kitchenDevice.findMany({
      where: { tenantId: c.tenantId, storeId: c.storeId },
      include: { user: { select: { email: true } }, station: { select: { id: true, name: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
    });
    const ids = devices.map(device => device.id);
    const [stations, activity, sessions] = await Promise.all([
      this.db.station.findMany({
        where: { tenantId: c.tenantId, storeId: c.storeId, deletedAt: null, active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      ids.length
        ? this.db.audit.findMany({
            where: {
              tenantId: c.tenantId,
              storeId: c.storeId,
              entityId: { in: ids },
              action: { startsWith: 'KITCHEN_DEVICE_' },
            },
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: { id: true, entityId: true, action: true, createdAt: true, details: true },
          })
        : Promise.resolve([]),
      this.db.session.findMany({
        where: {
          tenantId: c.tenantId,
          storeId: c.storeId,
          userId: { in: devices.map(device => device.userId) },
          expiresAt: { gt: new Date() },
        },
        orderBy: { expiresAt: 'desc' },
        select: { userId: true, expiresAt: true },
      }),
    ]);
    return {
      stations,
      devices: devices.map(device => ({
        id: device.id,
        email: device.user.email,
        station: device.station,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        sessionExpiresAt: sessions.find(session => session.userId === device.userId)?.expiresAt ?? null,
        activity: activity.filter(event => event.entityId === device.id).slice(0, 20),
      })),
    };
  }

  @Put('admin/kitchen/devices/:id/assignment')
  async assignKitchenDevice(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = parseUuid(id);
    const { stationId } = parseInput(kitchenDeviceAssignmentSchema, body);
    const { result, event } = await runSerializableTransactionWithRetry(
      this.db,
      async tx => {
        const current = await reauthorize(tx, c);
        if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
        if (
          stationId &&
          !(await tx.station.findFirst({
            where: { id: stationId, tenantId: current.tenantId, storeId: current.storeId, active: true, deletedAt: null },
            select: { id: true },
          }))
        ) {
          throw new BadRequestException('KITCHEN_STATION_NOT_AVAILABLE');
        }
        const changed = await tx.kitchenDevice.updateMany({
          where: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, revokedAt: null },
          data: { stationId },
        });
        if (changed.count !== 1) throw new NotFoundException('KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED');
        await tx.audit.create({
          data: {
            tenantId: current.tenantId,
            storeId: current.storeId,
            actorId: current.userId,
            action: 'KITCHEN_DEVICE_ASSIGNED',
            entityId: deviceId,
            commandKey: `kitchen-device:assignment:${randomUUID()}`,
            correlationId: current.correlationId,
            details: { stationId },
          },
        });
        const outboxRow = await tx.outbox.create({
          data: {
            tenantId: current.tenantId,
            storeId: current.storeId,
            type: 'kitchen.device.changed',
            aggregateId: deviceId,
            version: 1,
            correlationId: current.correlationId,
          },
        });
        return { result: { id: deviceId, stationId }, event: outboxRow };
      },
      { operation: 'kitchen.device.changed' },
    );
    publishOutboxRevocation(event, 'kitchen.device.changed');
    return result;
  }

  @Get('admin/kitchen/devices/:id/activity')
  async kitchenDeviceActivity(@Req() req: Request, @Param('id') id: string) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = parseUuid(id);
    if (
      !(await this.db.kitchenDevice.findFirst({
        where: { id: deviceId, tenantId: c.tenantId, storeId: c.storeId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('KITCHEN_DEVICE_NOT_FOUND');
    }
    return this.db.audit.findMany({
      where: {
        tenantId: c.tenantId,
        storeId: c.storeId,
        entityId: deviceId,
        action: { startsWith: 'KITCHEN_DEVICE_' },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { action: true, createdAt: true, details: true },
    });
  }

  @Post('admin/kitchen/devices/:id/revoke')
  async revokeKitchenDevice(@Req() req: Request, @Param('id') id: string) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = parseUuid(id);
    const event = await runSerializableTransactionWithRetry(
      this.db,
      async tx => {
        const current = await reauthorize(tx, c);
        if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
        const changed = await tx.kitchenDevice.updateMany({
          where: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (changed.count !== 1) throw new ConflictException('KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED');
        await tx.audit.create({
          data: {
            tenantId: current.tenantId,
            storeId: current.storeId,
            actorId: current.userId,
            action: 'KITCHEN_DEVICE_REVOKED',
            entityId: deviceId,
            commandKey: `kitchen-device:revoke:${randomUUID()}`,
            correlationId: current.correlationId,
          },
        });
        return tx.outbox.create({
          data: {
            tenantId: current.tenantId,
            storeId: current.storeId,
            type: 'kitchen.device.changed',
            aggregateId: deviceId,
            version: 1,
            correlationId: current.correlationId,
          },
        });
      },
      { operation: 'kitchen.device.changed' },
    );
    publishOutboxRevocation(event, 'kitchen.device.changed');
    return { id, revoked: true };
  }
}
