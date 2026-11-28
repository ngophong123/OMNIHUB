import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import {
  cashApprovalSchema,
  cashMovementSchema,
  cashRegisterSchema,
  cashShiftCloseSchema,
  cashShiftOpenSchema,
} from '@omnihub/contracts';
import { CashShifts } from '../../cash-shifts';
import { allowed } from '../../domain';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, idempotencyKey, parseInput, parseUuid } from '../../shared/http-helpers';

@Controller('cash')
export class CashShiftsController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(CashShifts) private readonly cashShifts: CashShifts,
  ) {}

  @Get('registers')
  async cashRegisters(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.cashShifts.registers(c);
  }

  @Get('assignments')
  async cashAssignments(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.cashShifts.assignments(c);
  }

  @Post('registers')
  async createCashRegister(@Req() req: Request, @Body() body: unknown) {
    return this.cashShifts.createRegister(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(cashRegisterSchema, body),
    );
  }

  @Get('shifts')
  async cashHistory(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'cashShift')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.cashShifts.history(c);
  }

  @Post('shifts')
  async openCashShift(@Req() req: Request, @Body() body: unknown) {
    return this.cashShifts.open(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(cashShiftOpenSchema, body),
    );
  }

  @Post('shifts/:id/close')
  async closeCashShift(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.cashShifts.close(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(cashShiftCloseSchema, body),
    );
  }

  @Post('shifts/:id/approve')
  async approveCashShift(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.cashShifts.approve(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(cashApprovalSchema, body),
    );
  }

  @Post('movements')
  async cashMovement(@Req() req: Request, @Body() body: unknown) {
    return this.cashShifts.move(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(cashMovementSchema, body),
    );
  }
}
