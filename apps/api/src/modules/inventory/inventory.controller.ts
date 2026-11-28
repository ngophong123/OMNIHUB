import { Body, Controller, ForbiddenException, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { movementListSchema, receiptSchema, stockSchema } from '@omnihub/contracts';
import { CatalogOperations } from '../../catalog-operations';
import { allowed } from '../../domain';
import { Operations } from '../../operations';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, idempotencyKey, parseInput } from '../../shared/http-helpers';

@Controller()
export class InventoryController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(Operations) private readonly ops: Operations,
    @Inject(CatalogOperations) private readonly catalog: CatalogOperations,
  ) {}

  @Get('inventory')
  async inventory(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED');
    const balances = await this.db.balance.findMany({
      where: { tenantId: c.tenantId, storeId: c.storeId },
      include: { ingredient: { select: { name: true, unit: true } } },
      orderBy: { ingredientId: 'asc' },
    });
    return balances.map(b => ({ ...b, available: b.onHand.sub(b.reserved).toFixed(3) }));
  }

  @Get('inventory/movements')
  async movements(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.db.movement.findMany({
      where: { tenantId: c.tenantId, storeId: c.storeId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('inventory/adjustments')
  async adjust(@Req() req: Request, @Body() body: unknown) {
    return this.ops.adjust(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(stockSchema, body),
    );
  }

  @Post('admin/inventory/receipts')
  async receipt(@Req() req: Request, @Body() body: unknown) {
    return this.catalog.receipt(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(receiptSchema, body),
    );
  }

  @Get('admin/inventory/movements')
  async movementList(@Req() req: Request, @Query() query: unknown) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'inventory')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.movements(c, parseInput(movementListSchema, query));
  }
}
