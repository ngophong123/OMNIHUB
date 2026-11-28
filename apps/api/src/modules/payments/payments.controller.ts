import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import {
  billSplitSchema,
  cashSchema,
  paymentFailureSchema,
  paymentSchema,
  refundDecisionSchema,
  refundRequestSchema,
} from '@omnihub/contracts';
import { allowed } from '../../domain';
import { Operations } from '../../operations';
import { Payments } from '../../payments';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, idempotencyKey, parseInput, parseUuid } from '../../shared/http-helpers';

@Controller()
export class PaymentsController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(Operations) private readonly ops: Operations,
    @Inject(Payments) private readonly payments: Payments,
  ) {}

  @Post('orders/:id/cash')
  async cash(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.cash(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(cashSchema, body),
    );
  }

  @Get('orders/:id/payments')
  async paymentHistory(@Req() req: Request, @Param('id') id: string) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'cash') && !allowed(c.role, 'report')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.payments.history(c, parseUuid(id));
  }

  @Post('orders/:id/payments')
  async recordPayment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.record(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(paymentSchema, body),
    );
  }

  @Post('orders/:id/splits')
  async splitBill(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.split(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(billSplitSchema, body),
    );
  }

  @Post('payments/:id/verify')
  async verifyPayment(@Req() req: Request, @Param('id') id: string) {
    return this.payments.verify(await authenticateRequest(this.db, req), idempotencyKey(req), parseUuid(id));
  }

  @Post('payments/:id/fail')
  async failPayment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.failPending(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(paymentFailureSchema, body).reason,
    );
  }

  @Post('payments/:id/refunds')
  async requestRefund(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.requestRefund(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(refundRequestSchema, body),
    );
  }

  @Post('refunds/:id/decision')
  async decideRefund(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.decideRefund(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(refundDecisionSchema, body),
    );
  }

  @Get('reports/daily')
  async report(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'report')) throw new ForbiddenException('PERMISSION_DENIED');
    const [paymentsByDay, refundsByDay] = await Promise.all([
      this.db.payment.groupBy({
        by: ['businessDate'],
        where: { tenantId: c.tenantId, storeId: c.storeId, status: 'SETTLED' },
        _sum: { amount: true },
        _count: { id: true },
        orderBy: { businessDate: 'desc' },
        take: 31,
      }),
      this.db.refund.groupBy({
        by: ['businessDate'],
        where: { tenantId: c.tenantId, storeId: c.storeId, status: 'APPROVED' },
        _sum: { amount: true },
      }),
    ]);
    const refunds = new Map(refundsByDay.map(row => [row.businessDate, row._sum.amount ?? 0]));
    const days = new Map(paymentsByDay.map(row => [row.businessDate, row]));
    for (const row of refundsByDay) {
      if (!days.has(row.businessDate)) {
        days.set(row.businessDate, { businessDate: row.businessDate, _sum: { amount: 0 }, _count: { id: 0 } });
      }
    }
    return [...days.values()]
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate))
      .slice(0, 31)
      .map(row => ({
        ...row,
        refunds: refunds.get(row.businessDate) ?? 0,
        net: (row._sum.amount ?? 0) - (refunds.get(row.businessDate) ?? 0),
      }));
  }
}
