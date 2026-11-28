import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import { orderSchema, versionSchema } from '@omnihub/contracts';
import { allowed, digest } from '../../domain';
import { Operations } from '../../operations';
import { QrOrdering } from '../../qr-ordering';
import { PRISMA_DB } from '../../shared/database.module';
import {
  authenticateRequest,
  extractBearerToken64,
  HEX64_RE,
  idempotencyKey,
  parseInput,
  parseUuid,
  requestCorrelationId,
} from '../../shared/http-helpers';

@Controller()
export class QrOrderingController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(QrOrdering) private readonly qrOrdering: QrOrdering,
    @Inject(Operations) private readonly ops: Operations,
  ) {}

  @Get('public/qr/:token/menu')
  async publicMenu(@Param('token') token: string) {
    return this.qrOrdering.publicMenu(token);
  }

  @Post('public/qr/:token/session')
  async openPublicSession(@Param('token') token: string) {
    return this.qrOrdering.openCustomerSession(token);
  }

  @Get('public/table-sessions/me')
  async customerSession(@Req() req: Request) {
    const bearer = extractBearerToken64(req);
    if (!bearer) throw new ForbiddenException('TABLE_SESSION_REQUIRED');
    return this.qrOrdering.customerSession(bearer);
  }

  @Post('public/table-sessions/orders')
  async acceptPublicOrder(@Req() req: Request, @Body() body: unknown) {
    const bearer = extractBearerToken64(req);
    if (!bearer) throw new ForbiddenException('TABLE_SESSION_REQUIRED');
    const session = await this.qrOrdering.validateCustomerSession(bearer);
    const ctx = {
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.id,
      role: 'CASHIER' as const,
      tokenHash: session.sessionTokenHash,
      expiresAt: session.expiresAt,
      correlationId: requestCorrelationId(req),
    };
    return this.ops.acceptFromTable(ctx, idempotencyKey(req), parseInput(orderSchema, body), session.id);
  }

  @Get('public/order-status/:token')
  async publicOrderStatus(@Param('token') token: string) {
    return this.qrOrdering.status(token);
  }

  @Get('admin/tables/config')
  async qrConfig(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.db.store.findFirstOrThrow({
      where: { tenantId: c.tenantId, id: c.storeId },
      select: { name: true, qrOrderingEnabled: true },
    });
  }

  @Put('admin/tables/config')
  async setQrConfig(@Req() req: Request, @Body() body: unknown) {
    const input = parseInput(z.object({ enabled: z.boolean() }).strict(), body);
    return this.qrOrdering.setStoreEnabled(await authenticateRequest(this.db, req), idempotencyKey(req), input.enabled);
  }

  @Get('admin/tables')
  async tables(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.qrOrdering.listTables(c);
  }

  @Get('admin/tables/qr-code')
  async tableQrCode(@Req() req: Request, @Query('token') token: string | undefined, @Res() res: Response) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    const resolvedToken = (req.get('X-QR-Token') ?? token)?.trim();
    if (!resolvedToken) throw new BadRequestException('QR_TOKEN_REQUIRED');
    if (!HEX64_RE.test(resolvedToken)) throw new BadRequestException('QR_TOKEN_INVALID');
    const table = await this.db.restaurantTable.findFirst({
      where: { tenantId: c.tenantId, storeId: c.storeId, qrTokenHash: digest(resolvedToken) },
      select: { id: true },
    });
    if (!table) throw new NotFoundException('TABLE_NOT_FOUND');
    const svg = await QRCode.toString(
      `${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/order/${resolvedToken}`,
      { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 420 },
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/svg+xml').send(svg);
  }

  @Post('admin/tables')
  async createTable(@Req() req: Request, @Body() body: unknown) {
    const input = parseInput(z.object({ name: z.string().trim().min(1).max(80) }).strict(), body);
    return this.qrOrdering.createTable(await authenticateRequest(this.db, req), idempotencyKey(req), input.name);
  }

  @Put('admin/tables/:id')
  async updateTable(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(
      z
        .object({
          name: z.string().trim().min(1).max(80),
          active: z.boolean(),
          qrEnabled: z.boolean(),
          expectedVersion: z.number().int().min(1),
        })
        .strict(),
      body,
    );
    return this.qrOrdering.updateTable(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      input.expectedVersion,
      input.name,
      input.active,
      input.qrEnabled,
    );
  }

  @Post('admin/tables/:id/regenerate-qr')
  async regenerateQr(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.qrOrdering.regenerate(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(versionSchema, body).expectedVersion,
    );
  }

  @Post('admin/tables/sessions/:id/close')
  async closeTableSession(@Req() req: Request, @Param('id') id: string) {
    return this.qrOrdering.closeTableSession(await authenticateRequest(this.db, req), idempotencyKey(req), parseUuid(id));
  }
}
