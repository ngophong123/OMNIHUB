import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpException, Module, NotFoundException, Param, Post, Put, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { cashSchema, cashRegisterSchema, cashShiftOpenSchema, cashShiftCloseSchema, cashMovementSchema, cashApprovalSchema, categoryListSchema, commandSchema, loginSchema, orderSchema, stockSchema, paymentSchema, refundRequestSchema, refundDecisionSchema, billSplitSchema, paymentFailureSchema, orderCancelSchema, kitchenDeviceSchema, kitchenSyncSchema, kitchenDeviceAssignmentSchema, invitationCreateSchema, invitationAcceptSchema } from '@omnihub/contracts';
import { z } from 'zod';
import { db, runSerializableTransactionWithRetry } from './database';
import { authenticate, login, reauthorize } from './auth';
import { allowed, digest } from './domain';
export { Errors } from './errors';
import { Operations } from './operations';
import { CatalogOperations } from './catalog-operations';
import { CashShifts } from './cash-shifts';
import { Payments } from './payments';
import { PilotAdmin } from './pilot-admin';
import { composeRecipe } from './catalog-domain';
import { categoryNameSchema, entitySchema, groupSchema, ingredientSchema, listSchema, modifierSchema, movementListSchema, productSchema, receiptSchema, variantSchema, versionSchema } from '@omnihub/contracts';
import { QrOrdering } from './qr-ordering';
import * as QRCode from 'qrcode';
import { Prisma } from '@prisma/client';
import { rateLimitRedisReady } from './rate-limit';
import { publishRealtimeOperationalEvent, realtimeRedisReady } from './realtime';
import { getLogContext } from './observability/request-context';

const ops = new Operations(db);
const catalog = new CatalogOperations(db);
const cashShifts = new CashShifts(db);
const payments = new Payments(db);
const qrOrdering = new QrOrdering(db);
const pilotAdmin = new PilotAdmin(db);
async function kitchenDevice(req: Request, ctx: Awaited<ReturnType<typeof context>>, required: boolean) {
  const raw = req.get('X-Kitchen-Device');
  if (!raw) { if (required) throw new ForbiddenException('KITCHEN_DEVICE_REQUIRED'); return undefined; }
  const device = await db.kitchenDevice.findFirst({ where: { id: uuid(raw), tenantId: ctx.tenantId, storeId: ctx.storeId, userId: ctx.userId, revokedAt: null }, select: { id: true, stationId: true } });
  if (!device) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
  return device;
}
async function auditKitchenDevice(ctx: Awaited<ReturnType<typeof context>>, id: string, action: string, details?: Record<string, unknown>) {
  await db.audit.create({ data: { tenantId: ctx.tenantId, storeId: ctx.storeId, actorId: ctx.userId, action, entityId: id, commandKey: `kitchen-device:${action}:${randomUUID()}`, correlationId: ctx.correlationId, ...(details ? { details: details as Prisma.InputJsonValue } : {}) } });
}
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('INVALID_INPUT');
  return result.data;
}
const context = (req: Request) => authenticate(db, typeof req.cookies?.session === 'string' ? req.cookies.session : undefined, String(req.res?.getHeader('x-correlation-id') ?? getLogContext()?.correlationId ?? ''));
const key = (req: Request) => req.get('Idempotency-Key') ?? '';
const uuid = (id: string) => parse(z.string().uuid(), id);
const HEX64_RE = /^[a-f0-9]{64}$/i;
function publishOutboxRevocation(
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

@Controller()
class ApiController {
  @Get('health') health() { return { status: 'ok' }; }
  @Get('ready') async ready() {
    await db.$queryRaw`SELECT 1`;
    if (!await rateLimitRedisReady()) throw new ServiceUnavailableException('REDIS_REQUIRED_FOR_PROTECTED_RATE_LIMITS');
    if (!await realtimeRedisReady()) throw new ServiceUnavailableException('REDIS_REQUIRED_FOR_REALTIME');
    return { database: 'ok', redis: 'ok', realtime: 'ok' };
  }
  @Post('auth/login') async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const data = parse(loginSchema, body);
    const session = await login(db, data.email, data.password, data.storeId);
    res.cookie('session', session.token, { httpOnly: true, sameSite: 'strict', secure: process.env.SESSION_SECURE !== 'false', expires: session.expiresAt, path: '/' });
    return { expiresAt: session.expiresAt };
  }
  @Get('auth/me') async me(@Req() req: Request) {
    const c = await context(req);
    const store = await db.store.findFirstOrThrow({ where: { id: c.storeId, tenantId: c.tenantId }, select: { name: true } });
    return { userId: c.userId, tenantId: c.tenantId, storeId: c.storeId, role: c.role, storeName: store.name };
  }
  @Post('auth/logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const c = await context(req);
    const revokedEvent = await db.$transaction(async tx => {
      const deleted = await tx.session.deleteMany({ where: { tokenHash: c.tokenHash } });
      if (deleted.count === 0) return null;
      return tx.outbox.create({
        data: {
          tenantId: c.tenantId,
          storeId: c.storeId,
          type: 'session.revoked',
          aggregateId: c.userId,
          version: 1,
          correlationId: c.correlationId,
        },
      });
    });
    if (revokedEvent) {
      publishOutboxRevocation(revokedEvent, 'session.revoked');
    }
    res.clearCookie('session', { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.SESSION_SECURE !== 'false' });
    return { ok: true };
  }
  @Get('public/qr/:token/menu') async publicMenu(@Param('token') token: string) { return qrOrdering.publicMenu(token); }
  @Post('public/qr/:token/session') async openPublicSession(@Param('token') token: string) { return qrOrdering.openCustomerSession(token); }
  @Get('public/table-sessions/me') async customerSession(@Req() req: Request) { const bearer = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1]; if (!bearer) throw new ForbiddenException('TABLE_SESSION_REQUIRED'); return qrOrdering.customerSession(bearer); }
  @Post('public/table-sessions/orders') async acceptPublicOrder(@Req() req: Request, @Body() body: unknown) {
    const bearer = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if (!bearer) throw new ForbiddenException('TABLE_SESSION_REQUIRED');
    const session = await qrOrdering.validateCustomerSession(bearer);
    const ctx = { tenantId: session.tenantId, storeId: session.storeId, userId: session.id, role: 'CASHIER' as const, tokenHash: session.sessionTokenHash, expiresAt: session.expiresAt, correlationId: String(req.res?.getHeader('x-correlation-id') ?? getLogContext()?.correlationId ?? '') };
    return ops.acceptFromTable(ctx, key(req), parse(orderSchema, body), session.id);
  }
  @Post('public/invitations/:token/accept') async acceptInvitation(@Req() req: Request, @Param('token') token: string, @Body() body: unknown) {
    const correlationId = String(req.res?.getHeader('x-correlation-id') ?? getLogContext()?.correlationId ?? '');
    return pilotAdmin.acceptInvitation(token, parse(invitationAcceptSchema, body).password, correlationId);
  }
  @Get('public/order-status/:token') async publicOrderStatus(@Param('token') token: string) { return qrOrdering.status(token); }
  @Get('catalog') async catalog(@Req() req: Request) {
    const c = await context(req);
    const rows = await db.product.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null, station: { active: true, deletedAt: null }, OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }] }, include: { recipe: true, variants: { where: { active: true, deletedAt: null } }, modifierGroups: { where: { active: true, deletedAt: null }, include: { options: { where: { active: true, deletedAt: null }, include: { recipe: true } } } } }, orderBy: { name: 'asc' } });
    const availability = await catalog.availability(c, rows.map(p => ({ id: p.id, recipe: p.recipe })));
    const variantAvailability = await catalog.availability(c, rows.flatMap(p => p.variants.map(v => ({ id: v.id, recipe: composeRecipe(p.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) })), v.recipeMultiplier.toFixed(3), []) }))));
    return rows.map(p => ({ ...p, variants: p.variants.map(v => ({ ...v, available: variantAvailability.get(v.id) ?? false })), stockAvailable: availability.get(p.id) ?? false, available: p.manualAvailable && (availability.get(p.id) ?? false) && p.recipe.length > 0 }));
  }
  @Get('orders') async orders(@Req() req: Request) {
    const c = await context(req);
    const device = await kitchenDevice(req, c, c.role === 'KITCHEN');
    const itemScope = device?.stationId ? { ticket: { stationId: device.stationId } } : undefined;
    return db.order.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, ...(itemScope ? { items: { some: itemScope } } : {}) }, include: { items: { ...(itemScope ? { where: itemScope } : {}), orderBy: { id: 'asc' } }, tickets: { ...(device?.stationId ? { where: { stationId: device.stationId } } : {}), include: { station: { select: { name: true } } } }, payments: { select: { id: true, amount: true, tendered: true, change: true, method: true, status: true, externalReference: true, splitId: true, businessDate: true, createdAt: true } }, refunds: { orderBy: { createdAt: 'asc' } }, billSplits: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Post('orders') async accept(@Req() req: Request, @Body() body: unknown) { return ops.accept(await context(req), key(req), parse(orderSchema, body)); }
  @Post('orders/:id/cancel') async cancelOrder(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return ops.cancelOrder(await context(req), key(req), uuid(id), parse(orderCancelSchema, body)); }
  @Post('items/:id/commands') async command(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const c = await context(req); const device = await kitchenDevice(req, c, c.role === 'KITCHEN'); const itemId = uuid(id);
    if (device?.stationId && !await db.orderItem.findFirst({ where: { id: itemId, tenantId: c.tenantId, storeId: c.storeId, ticket: { stationId: device.stationId } }, select: { id: true } })) throw new ForbiddenException('KITCHEN_STATION_SCOPE_MISMATCH');
    return ops.item(c, key(req), itemId, parse(commandSchema, body), device ? { kitchenDeviceId: device.id } : undefined);
  }
  @Post('kitchen/devices/register') async registerKitchenDevice(@Req() req: Request, @Body() body: unknown) {
    const c = await context(req); const { deviceId } = parse(kitchenDeviceSchema, body);
    if (!allowed(c.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
    await runSerializableTransactionWithRetry(db, async tx => {
      const current = await reauthorize(tx, c);
      if (!allowed(current.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
      const existing = await tx.kitchenDevice.findUnique({ where: { id: deviceId } });
      if (existing) {
        if (existing.tenantId !== current.tenantId || existing.storeId !== current.storeId || existing.userId !== current.userId || existing.revokedAt) {
          throw new ForbiddenException('KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE');
        }
        const updated = await tx.kitchenDevice.updateMany({
          where: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, userId: current.userId, revokedAt: null },
          data: { lastSeenAt: new Date() },
        });
        if (updated.count !== 1) throw new ForbiddenException('KITCHEN_DEVICE_REVOKED_OR_OUT_OF_SCOPE');
        return;
      }
      await tx.kitchenDevice.create({ data: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, userId: current.userId } });
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: current.userId, action: 'KITCHEN_DEVICE_REGISTERED', entityId: deviceId, commandKey: `kitchen-device:KITCHEN_DEVICE_REGISTERED:${randomUUID()}`, correlationId: current.correlationId } });
    }, { operation: 'kitchen.device.changed' });
    return { deviceId, authorized: true };
  }
  @Post('kitchen/sync') async syncKitchenCommands(@Req() req: Request, @Body() body: unknown) {
    const c = await context(req); const { commands } = parse(kitchenSyncSchema, body);
    if (!allowed(c.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
    if (commands.some(command => command.tenantId !== c.tenantId || command.storeId !== c.storeId || command.userId !== c.userId) || new Set(commands.map(command => command.commandId)).size !== commands.length || new Set(commands.map(command => command.sequence)).size !== commands.length || commands.some((command, index) => index > 0 && command.sequence <= commands[index - 1]!.sequence)) throw new BadRequestException('INVALID_REPLAY_SCOPE_OR_ORDER');
    const deviceIds = new Set(commands.map(command => command.deviceId));
    if (deviceIds.size > 1) throw new BadRequestException('MULTIPLE_REPLAY_DEVICES');
    let device: { id: string; stationId: string | null } | null = null;
    if (commands.length) {
      const headerDeviceId = req.get('X-Kitchen-Device');
      if (headerDeviceId !== commands[0]!.deviceId) throw new ForbiddenException('KITCHEN_DEVICE_HEADER_MISMATCH');
      device = await db.kitchenDevice.findFirst({ where: { id: commands[0]!.deviceId, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null }, select: { id: true, stationId: true } });
      if (!device) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
      const touched = await db.kitchenDevice.updateMany({ where: { id: device.id, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null }, data: { lastSeenAt: new Date() } });
      if (touched.count !== 1) throw new ForbiddenException('KITCHEN_DEVICE_NOT_AUTHORIZED');
    }
    const blockedOrders = new Set<string>(); const results: { commandId: string; status: 'CONFIRMED' | 'CONFLICT' | 'REJECTED' | 'BLOCKED'; version?: number; code?: string }[] = [];
    for (const command of commands) {
      if (blockedOrders.has(command.orderId)) { results.push({ commandId: command.commandId, status: 'BLOCKED', code: 'PREVIOUS_COMMAND_CONFLICT' }); continue; }
      try {
        const created = Date.parse(command.createdAt);
        if (!Number.isFinite(created) || created > Date.now() + 5 * 60_000 || created < Date.now() - 30 * 24 * 60 * 60_000) throw new ConflictException('OFFLINE_COMMAND_EXPIRED');
        const item = await db.orderItem.findFirst({ where: { tenantId: c.tenantId, storeId: c.storeId, id: command.itemId, ...(device?.stationId ? { ticket: { stationId: device.stationId } } : {}) }, select: { orderId: true } });
        if (!item || item.orderId !== command.orderId) throw new ForbiddenException('KITCHEN_COMMAND_SCOPE_MISMATCH');
        const result = await ops.item(c, command.commandId, command.itemId, { action: command.action, expectedVersion: command.expectedVersion }, { kitchenDeviceId: device!.id });
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
    if (commands.length) await auditKitchenDevice(c, commands[0]!.deviceId, 'KITCHEN_DEVICE_SYNCED', { count: commands.length, confirmed: results.filter(row => row.status === 'CONFIRMED').length, rejected: results.filter(row => row.status === 'REJECTED' || row.status === 'CONFLICT' || row.status === 'BLOCKED').length });
    return { results };
  }
  @Get('admin/kitchen/devices') async listKitchenDevices(@Req() req: Request) {
    const c = await context(req); if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const devices = await db.kitchenDevice.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId }, include: { user: { select: { email: true } }, station: { select: { id: true, name: true } } }, orderBy: { lastSeenAt: 'desc' }, take: 200 });
    const ids = devices.map(device => device.id);
    const [stations, activity, sessions] = await Promise.all([
      db.station.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, deletedAt: null, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      ids.length ? db.audit.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, entityId: { in: ids }, action: { startsWith: 'KITCHEN_DEVICE_' } }, orderBy: { createdAt: 'desc' }, take: 500, select: { id: true, entityId: true, action: true, createdAt: true, details: true } }) : Promise.resolve([]),
      db.session.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, userId: { in: devices.map(device => device.userId) }, expiresAt: { gt: new Date() } }, orderBy: { expiresAt: 'desc' }, select: { userId: true, expiresAt: true } }),
    ]);
    return { stations, devices: devices.map(device => ({ id: device.id, email: device.user.email, station: device.station, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt, sessionExpiresAt: sessions.find(session => session.userId === device.userId)?.expiresAt ?? null, activity: activity.filter(event => event.entityId === device.id).slice(0, 20) })) };
  }
  @Get('admin/pilot-readiness') async pilotReadiness(@Req() req: Request) {
    const c = await context(req); if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const store = await db.store.findFirstOrThrow({ where: { id: c.storeId, tenantId: c.tenantId }, select: { name: true, timezone: true, dayStart: true, qrOrderingEnabled: true } });
    const [employees, stations, activeProducts, productsWithRecipes, ingredients, openingBalances, registers, tables, devices] = await Promise.all([
      db.membership.count({ where: { tenantId: c.tenantId, storeId: c.storeId } }),
      db.station.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null } }),
      db.product.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null, station: { active: true, deletedAt: null }, OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }] } }),
      db.product.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null, station: { active: true, deletedAt: null }, OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }], recipe: { some: {} } } }),
      db.ingredient.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null } }),
      db.balance.count({ where: { tenantId: c.tenantId, storeId: c.storeId, onHand: { gt: 0 } } }),
      db.cashRegister.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true } }),
      db.restaurantTable.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, qrEnabled: true } }),
      db.kitchenDevice.count({ where: { tenantId: c.tenantId, storeId: c.storeId, revokedAt: null } }),
    ]);
    return { store, checks: { storeConfigured: Boolean(store.name.trim() && store.timezone && store.dayStart >= 0 && store.dayStart < 1440), employees, stations, activeProducts, productsWithRecipes, ingredients, openingBalances, registers, qrOrderingEnabled: store.qrOrderingEnabled, activeQrTables: tables, activeKitchenDevices: devices } };
  }
  @Get('admin/invitations') async listInvitations(@Req() req: Request) { return pilotAdmin.listInvitations(await context(req)); }
  @Post('admin/invitations') async createInvitation(@Req() req: Request, @Body() body: unknown) { const c = await context(req); const invitation = parse(invitationCreateSchema, body); return pilotAdmin.createInvitation(c, invitation); }
  @Post('admin/invitations/:id/revoke') async revokeInvitation(@Req() req: Request, @Param('id') id: string) { return pilotAdmin.revokeInvitation(await context(req), uuid(id)); }
  @Put('admin/kitchen/devices/:id/assignment') async assignKitchenDevice(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const c = await context(req); if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = uuid(id); const { stationId } = parse(kitchenDeviceAssignmentSchema, body);
    const { result, event } = await runSerializableTransactionWithRetry(db, async tx => {
      const current = await reauthorize(tx, c);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      if (stationId && !await tx.station.findFirst({ where: { id: stationId, tenantId: current.tenantId, storeId: current.storeId, active: true, deletedAt: null }, select: { id: true } })) throw new BadRequestException('KITCHEN_STATION_NOT_AVAILABLE');
      const changed = await tx.kitchenDevice.updateMany({ where: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, revokedAt: null }, data: { stationId } });
      if (changed.count !== 1) throw new NotFoundException('KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED');
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: current.userId, action: 'KITCHEN_DEVICE_ASSIGNED', entityId: deviceId, commandKey: `kitchen-device:assignment:${randomUUID()}`, correlationId: current.correlationId, details: { stationId } } });
      const outboxRow = await tx.outbox.create({ data: { tenantId: current.tenantId, storeId: current.storeId, type: 'kitchen.device.changed', aggregateId: deviceId, version: 1, correlationId: current.correlationId } });
      return { result: { id: deviceId, stationId }, event: outboxRow };
    }, { operation: 'kitchen.device.changed' });
    publishOutboxRevocation(event, 'kitchen.device.changed');
    return result;
  }
  @Get('admin/kitchen/devices/:id/activity') async kitchenDeviceActivity(@Req() req: Request, @Param('id') id: string) {
    const c = await context(req); if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = uuid(id); if (!await db.kitchenDevice.findFirst({ where: { id: deviceId, tenantId: c.tenantId, storeId: c.storeId }, select: { id: true } })) throw new NotFoundException('KITCHEN_DEVICE_NOT_FOUND');
    return db.audit.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId, entityId: deviceId, action: { startsWith: 'KITCHEN_DEVICE_' } }, orderBy: { createdAt: 'desc' }, take: 100, select: { action: true, createdAt: true, details: true } });
  }
  @Post('admin/kitchen/devices/:id/revoke') async revokeKitchenDevice(@Req() req: Request, @Param('id') id: string) {
    const c = await context(req); if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const deviceId = uuid(id);
    const event = await runSerializableTransactionWithRetry(db, async tx => {
      const current = await reauthorize(tx, c);
      if (!allowed(current.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
      const changed = await tx.kitchenDevice.updateMany({ where: { id: deviceId, tenantId: current.tenantId, storeId: current.storeId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (changed.count !== 1) throw new ConflictException('KITCHEN_DEVICE_NOT_FOUND_OR_REVOKED');
      await tx.audit.create({ data: { tenantId: current.tenantId, storeId: current.storeId, actorId: current.userId, action: 'KITCHEN_DEVICE_REVOKED', entityId: deviceId, commandKey: `kitchen-device:revoke:${randomUUID()}`, correlationId: current.correlationId } });
      return tx.outbox.create({ data: { tenantId: current.tenantId, storeId: current.storeId, type: 'kitchen.device.changed', aggregateId: deviceId, version: 1, correlationId: current.correlationId } });
    }, { operation: 'kitchen.device.changed' });
    publishOutboxRevocation(event, 'kitchen.device.changed');
    return { id, revoked: true };
  }
  @Post('orders/:id/cash') async cash(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return ops.cash(await context(req), key(req), uuid(id), parse(cashSchema, body)); }
  @Get('orders/:id/payments') async paymentHistory(@Req() req: Request, @Param('id') id: string) { return payments.history(await context(req), uuid(id)); }
  @Post('orders/:id/payments') async recordPayment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return payments.record(await context(req), key(req), uuid(id), parse(paymentSchema, body)); }
  @Post('orders/:id/splits') async splitBill(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return payments.split(await context(req), key(req), uuid(id), parse(billSplitSchema, body)); }
  @Post('payments/:id/verify') async verifyPayment(@Req() req: Request, @Param('id') id: string) { return payments.verify(await context(req), key(req), uuid(id)); }
  @Post('payments/:id/fail') async failPayment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return payments.failPending(await context(req), key(req), uuid(id), parse(paymentFailureSchema, body).reason); }
  @Post('payments/:id/refunds') async requestRefund(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return payments.requestRefund(await context(req), key(req), uuid(id), parse(refundRequestSchema, body)); }
  @Post('refunds/:id/decision') async decideRefund(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return payments.decideRefund(await context(req), key(req), uuid(id), parse(refundDecisionSchema, body)); }
  @Get('inventory') async inventory(@Req() req: Request) {
    const c = await context(req);
    if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED');
    const balances = await db.balance.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId }, include: { ingredient: { select: { name: true, unit: true } } }, orderBy: { ingredientId: 'asc' } });
    return balances.map(b => ({ ...b, available: b.onHand.sub(b.reserved).toFixed(3) }));
  }
  @Get('inventory/movements') async movements(@Req() req: Request) {
    const c = await context(req);
    if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED');
    return db.movement.findMany({ where: { tenantId: c.tenantId, storeId: c.storeId }, orderBy: { createdAt: 'desc' }, take: 200 });
  }
  @Post('inventory/adjustments') async adjust(@Req() req: Request, @Body() body: unknown) { return ops.adjust(await context(req), key(req), parse(stockSchema, body)); }
  @Get('reports/daily') async report(@Req() req: Request) {
    const c = await context(req);
    if (!allowed(c.role, 'report')) throw new ForbiddenException('PERMISSION_DENIED');
    const [paymentsByDay, refundsByDay] = await Promise.all([
      db.payment.groupBy({ by: ['businessDate'], where: { tenantId: c.tenantId, storeId: c.storeId, status: 'SETTLED' }, _sum: { amount: true }, _count: { id: true }, orderBy: { businessDate: 'desc' }, take: 31 }),
      db.refund.groupBy({ by: ['businessDate'], where: { tenantId: c.tenantId, storeId: c.storeId, status: 'APPROVED' }, _sum: { amount: true } }),
    ]);
    const refunds = new Map(refundsByDay.map(row => [row.businessDate, row._sum.amount ?? 0]));
    const days = new Map(paymentsByDay.map(row => [row.businessDate, row]));
    for (const row of refundsByDay) if (!days.has(row.businessDate)) days.set(row.businessDate, { businessDate: row.businessDate, _sum: { amount: 0 }, _count: { id: 0 } });
    return [...days.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate)).slice(0, 31).map(row => ({ ...row, refunds: refunds.get(row.businessDate) ?? 0, net: (row._sum.amount ?? 0) - (refunds.get(row.businessDate) ?? 0) }));
  }

  @Get('cash/registers') async cashRegisters(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED'); return cashShifts.registers(c); }
  @Get('cash/assignments') async cashAssignments(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED'); return cashShifts.assignments(c); }
  @Post('cash/registers') async createCashRegister(@Req() req: Request, @Body() body: unknown) { return cashShifts.createRegister(await context(req), key(req), parse(cashRegisterSchema, body)); }
  @Get('cash/shifts') async cashHistory(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED'); return cashShifts.history(c); }
  @Post('cash/shifts') async openCashShift(@Req() req: Request, @Body() body: unknown) { return cashShifts.open(await context(req), key(req), parse(cashShiftOpenSchema, body)); }
  @Post('cash/shifts/:id/close') async closeCashShift(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return cashShifts.close(await context(req), key(req), uuid(id), parse(cashShiftCloseSchema, body)); }
  @Post('cash/shifts/:id/approve') async approveCashShift(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return cashShifts.approve(await context(req), key(req), uuid(id), parse(cashApprovalSchema, body)); }
  @Post('cash/movements') async cashMovement(@Req() req: Request, @Body() body: unknown) { return cashShifts.move(await context(req), key(req), parse(cashMovementSchema, body)); }

  @Get('admin/categories') async categories(@Req() req: Request, @Query() query: unknown) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.categories(c, parse(categoryListSchema, query)); }
  @Get('admin/tables/config') async qrConfig(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return db.store.findFirstOrThrow({ where: { tenantId: c.tenantId, id: c.storeId }, select: { name: true, qrOrderingEnabled: true } }); }
  @Put('admin/tables/config') async setQrConfig(@Req() req: Request, @Body() body: unknown) { const input = parse(z.object({ enabled: z.boolean() }).strict(), body); return qrOrdering.setStoreEnabled(await context(req), key(req), input.enabled); }
  @Get('admin/tables') async tables(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return qrOrdering.listTables(c); }
  @Get('admin/tables/qr-code') async tableQrCode(@Req() req: Request, @Query('token') token: string | undefined, @Res() res: Response) {
    const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    const resolvedToken = (req.get('X-QR-Token') ?? token)?.trim();
    if (!resolvedToken) throw new BadRequestException('QR_TOKEN_REQUIRED');
    if (!HEX64_RE.test(resolvedToken)) throw new BadRequestException('QR_TOKEN_INVALID');
    const table = await db.restaurantTable.findFirst({ where: { tenantId: c.tenantId, storeId: c.storeId, qrTokenHash: digest(resolvedToken) }, select: { id: true } });
    if (!table) throw new NotFoundException('TABLE_NOT_FOUND');
    const svg = await QRCode.toString(`${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/order/${resolvedToken}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 420 });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/svg+xml').send(svg);
  }
  @Post('admin/tables') async createTable(@Req() req: Request, @Body() body: unknown) { const input = parse(z.object({ name: z.string().trim().min(1).max(80) }).strict(), body); return qrOrdering.createTable(await context(req), key(req), input.name); }
  @Put('admin/tables/:id') async updateTable(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(z.object({ name: z.string().trim().min(1).max(80), active: z.boolean(), qrEnabled: z.boolean(), expectedVersion: z.number().int().min(1) }).strict(), body); return qrOrdering.updateTable(await context(req), key(req), uuid(id), input.expectedVersion, input.name, input.active, input.qrEnabled); }
  @Post('admin/tables/:id/regenerate-qr') async regenerateQr(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return qrOrdering.regenerate(await context(req), key(req), uuid(id), parse(versionSchema, body).expectedVersion); }
  @Post('admin/tables/sessions/:id/close') async closeTableSession(@Req() req: Request, @Param('id') id: string) { return qrOrdering.closeTableSession(await context(req), key(req), uuid(id)); }
  @Post('admin/categories') async createCategory(@Req() req: Request, @Body() body: unknown) { return catalog.createCategory(await context(req), key(req), parse(categoryNameSchema, body).name); }
  @Put('admin/categories/:id') async updateCategory(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(categoryNameSchema.extend({ ...versionSchema.shape, active: entitySchema.shape.active }), body); return catalog.updateCategory(await context(req), key(req), uuid(id), input.expectedVersion, input.name, input.active); }
  @Delete('admin/categories/:id') async archiveCategory(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.archiveCategory(await context(req), key(req), uuid(id), parse(versionSchema, body).expectedVersion); }

  @Get('admin/stations') async stations(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.stations(c); }
  @Post('admin/stations') async createStation(@Req() req: Request, @Body() body: unknown) { const input = parse(entitySchema, body); return catalog.saveStation(await context(req), key(req), undefined, undefined, input.name, input.active); }
  @Put('admin/stations/:id') async updateStation(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(entitySchema.extend(versionSchema.shape), body); return catalog.saveStation(await context(req), key(req), uuid(id), input.expectedVersion, input.name, input.active); }
  @Delete('admin/stations/:id') async archiveStation(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.archiveStation(await context(req), key(req), uuid(id), parse(versionSchema, body).expectedVersion); }

  @Get('admin/ingredients') async ingredients(@Req() req: Request) { const c = await context(req); if (!allowed(c.role, 'inventory') && !allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.ingredients(c); }
  @Post('admin/ingredients') async createIngredient(@Req() req: Request, @Body() body: unknown) { return catalog.saveIngredient(await context(req), key(req), parse(ingredientSchema, body)); }
  @Put('admin/ingredients/:id') async updateIngredient(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(ingredientSchema.extend(versionSchema.shape), body); return catalog.saveIngredient(await context(req), key(req), input, uuid(id), input.expectedVersion); }
  @Delete('admin/ingredients/:id') async archiveIngredient(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.archiveIngredient(await context(req), key(req), uuid(id), parse(versionSchema, body).expectedVersion); }

  @Get('admin/products') async listProducts(@Req() req: Request, @Query() query: unknown) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.listProducts(c, parse(listSchema, query)); }
  @Post('admin/products') async createProduct(@Req() req: Request, @Body() body: unknown) { return catalog.createProduct(await context(req), key(req), parse(productSchema, body)); }
  @Put('admin/products/:id') async updateProduct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(productSchema.extend(versionSchema.shape), body); return catalog.updateProduct(await context(req), key(req), uuid(id), input.expectedVersion, input); }
  @Delete('admin/products/:id') async archiveProduct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.archiveProduct(await context(req), key(req), uuid(id), parse(versionSchema, body).expectedVersion); }
  @Post('admin/products/:id/availability') async setAvailability(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(versionSchema.extend({ available: entitySchema.shape.active }), body); return catalog.setAvailability(await context(req), key(req), uuid(id), input.expectedVersion, input.available); }
  @Get('admin/products/:id/variants') async variants(@Req() req: Request, @Param('id') id: string) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.variants(c, uuid(id)); }
  @Post('admin/products/:id/variants') async createVariant(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { const input = parse(variantSchema, body); return catalog.saveVariant(await context(req), key(req), uuid(id), undefined, undefined, input); }
  @Put('admin/products/:productId/variants/:id') async updateVariant(@Req() req: Request, @Param('productId') productId: string, @Param('id') id: string, @Body() body: unknown) { const input = parse(variantSchema.extend(versionSchema.shape), body); return catalog.saveVariant(await context(req), key(req), uuid(productId), uuid(id), input.expectedVersion, input); }
  @Get('admin/products/:id/modifier-groups') async groups(@Req() req: Request, @Param('id') id: string) { const c = await context(req); if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.groups(c, uuid(id)); }
  @Post('admin/products/:id/modifier-groups') async createGroup(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.saveGroup(await context(req), key(req), uuid(id), undefined, undefined, parse(groupSchema, body)); }
  @Put('admin/products/:productId/modifier-groups/:id') async updateGroup(@Req() req: Request, @Param('productId') productId: string, @Param('id') id: string, @Body() body: unknown) { const input = parse(groupSchema.extend(versionSchema.shape), body); return catalog.saveGroup(await context(req), key(req), uuid(productId), uuid(id), input.expectedVersion, input); }
  @Post('admin/modifier-groups/:id/options') async createModifier(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return catalog.saveModifier(await context(req), key(req), uuid(id), undefined, undefined, parse(modifierSchema, body)); }
  @Put('admin/modifier-groups/:groupId/options/:id') async updateModifier(@Req() req: Request, @Param('groupId') groupId: string, @Param('id') id: string, @Body() body: unknown) { const input = parse(modifierSchema.extend(versionSchema.shape), body); return catalog.saveModifier(await context(req), key(req), uuid(groupId), uuid(id), input.expectedVersion, input); }
  @Post('admin/inventory/receipts') async receipt(@Req() req: Request, @Body() body: unknown) { return catalog.receipt(await context(req), key(req), parse(receiptSchema, body)); }
  @Get('admin/inventory/movements') async movementList(@Req() req: Request, @Query() query: unknown) { const c = await context(req); if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED'); return catalog.movements(c, parse(movementListSchema, query)); }
}

@Module({ controllers: [ApiController] })
export class AppModule {}
