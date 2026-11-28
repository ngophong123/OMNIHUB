import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { invitationAcceptSchema, invitationCreateSchema } from '@omnihub/contracts';
import { allowed } from '../../domain';
import { PilotAdmin } from '../../pilot-admin';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, parseInput, parseUuid, requestCorrelationId } from '../../shared/http-helpers';

@Controller()
export class AdminController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(PilotAdmin) private readonly pilotAdmin: PilotAdmin,
  ) {}

  @Get('admin/pilot-readiness')
  async pilotReadiness(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const store = await this.db.store.findFirstOrThrow({
      where: { id: c.storeId, tenantId: c.tenantId },
      select: { name: true, timezone: true, dayStart: true, qrOrderingEnabled: true },
    });
    const [
      employees,
      stations,
      activeProducts,
      productsWithRecipes,
      ingredients,
      openingBalances,
      registers,
      tables,
      devices,
    ] = await Promise.all([
      this.db.membership.count({ where: { tenantId: c.tenantId, storeId: c.storeId } }),
      this.db.station.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null } }),
      this.db.product.count({
        where: {
          tenantId: c.tenantId,
          storeId: c.storeId,
          active: true,
          deletedAt: null,
          station: { active: true, deletedAt: null },
          OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }],
        },
      }),
      this.db.product.count({
        where: {
          tenantId: c.tenantId,
          storeId: c.storeId,
          active: true,
          deletedAt: null,
          station: { active: true, deletedAt: null },
          OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }],
          recipe: { some: {} },
        },
      }),
      this.db.ingredient.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, deletedAt: null } }),
      this.db.balance.count({ where: { tenantId: c.tenantId, storeId: c.storeId, onHand: { gt: 0 } } }),
      this.db.cashRegister.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true } }),
      this.db.restaurantTable.count({ where: { tenantId: c.tenantId, storeId: c.storeId, active: true, qrEnabled: true } }),
      this.db.kitchenDevice.count({ where: { tenantId: c.tenantId, storeId: c.storeId, revokedAt: null } }),
    ]);
    return {
      store,
      checks: {
        storeConfigured: Boolean(store.name.trim() && store.timezone && store.dayStart >= 0 && store.dayStart < 1440),
        employees,
        stations,
        activeProducts,
        productsWithRecipes,
        ingredients,
        openingBalances,
        registers,
        qrOrderingEnabled: store.qrOrderingEnabled,
        activeQrTables: tables,
        activeKitchenDevices: devices,
      },
    };
  }

  @Get('admin/invitations')
  async listInvitations(@Req() req: Request) {
    return this.pilotAdmin.listInvitations(await authenticateRequest(this.db, req));
  }

  @Post('admin/invitations')
  async createInvitation(@Req() req: Request, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    const invitation = parseInput(invitationCreateSchema, body);
    return this.pilotAdmin.createInvitation(c, invitation);
  }

  @Post('admin/invitations/:id/revoke')
  async revokeInvitation(@Req() req: Request, @Param('id') id: string) {
    return this.pilotAdmin.revokeInvitation(await authenticateRequest(this.db, req), parseUuid(id));
  }

  @Post('public/invitations/:token/accept')
  async acceptInvitation(@Req() req: Request, @Param('token') token: string, @Body() body: unknown) {
    return this.pilotAdmin.acceptInvitation(
      token,
      parseInput(invitationAcceptSchema, body).password,
      requestCorrelationId(req),
    );
  }
}
