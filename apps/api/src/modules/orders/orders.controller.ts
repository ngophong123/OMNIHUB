import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { commandSchema, orderCancelSchema, orderSchema } from '@omnihub/contracts';
import { allowed } from '../../domain';
import { Operations } from '../../operations';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, idempotencyKey, parseInput, parseUuid } from '../../shared/http-helpers';
import { resolveKitchenDevice } from '../kitchen/kitchen-device.helper';

@Controller()
export class OrdersController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(Operations) private readonly ops: Operations,
  ) {}

  @Get('orders')
  async orders(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'pos') && !allowed(c.role, 'kitchen')) throw new ForbiddenException('PERMISSION_DENIED');
    const device = await resolveKitchenDevice(this.db, req, c, c.role === 'KITCHEN');
    const itemScope = device?.stationId ? { ticket: { stationId: device.stationId } } : undefined;
    const includeFinancials = allowed(c.role, 'cash') || allowed(c.role, 'report');
    const rows = await this.db.order.findMany({
      where: { tenantId: c.tenantId, storeId: c.storeId, ...(itemScope ? { items: { some: itemScope } } : {}) },
      include: {
        items: { ...(itemScope ? { where: itemScope } : {}), orderBy: { id: 'asc' } },
        tickets: {
          ...(device?.stationId ? { where: { stationId: device.stationId } } : {}),
          include: { station: { select: { name: true } } },
        },
        ...(includeFinancials
          ? {
              payments: {
                select: {
                  id: true,
                  amount: true,
                  tendered: true,
                  change: true,
                  method: true,
                  status: true,
                  externalReference: true,
                  splitId: true,
                  businessDate: true,
                  createdAt: true,
                },
              },
              refunds: { orderBy: { createdAt: 'asc' as const } },
              billSplits: true,
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (includeFinancials) return rows;
    return rows.map(row => ({ ...row, payments: [], refunds: [], billSplits: [] }));
  }

  @Post('orders')
  async accept(@Req() req: Request, @Body() body: unknown) {
    return this.ops.accept(await authenticateRequest(this.db, req), idempotencyKey(req), parseInput(orderSchema, body));
  }

  @Post('orders/:id/cancel')
  async cancelOrder(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.cancelOrder(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(orderCancelSchema, body),
    );
  }

  @Post('items/:id/commands')
  async command(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    const device = await resolveKitchenDevice(this.db, req, c, c.role === 'KITCHEN');
    const itemId = parseUuid(id);
    if (
      device?.stationId &&
      !(await this.db.orderItem.findFirst({
        where: { id: itemId, tenantId: c.tenantId, storeId: c.storeId, ticket: { stationId: device.stationId } },
        select: { id: true },
      }))
    ) {
      throw new ForbiddenException('KITCHEN_STATION_SCOPE_MISMATCH');
    }
    return this.ops.item(
      c,
      idempotencyKey(req),
      itemId,
      parseInput(commandSchema, body),
      device ? { kitchenDeviceId: device.id } : undefined,
    );
  }
}
