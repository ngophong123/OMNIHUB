import { Body, Controller, ForbiddenException, Get, Inject, Post, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import { allowed } from '../../domain';
import { listDeadLetterOutbox, replayDeadLetterOutbox } from '../../outbox';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, parseInput } from '../../shared/http-helpers';

@Controller('admin/outbox')
export class OutboxController {
  constructor(@Inject(PRISMA_DB) private readonly db: PrismaClient) {}

  @Get('dead-letters')
  async listDeadLetters(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    return listDeadLetterOutbox(this.db, { tenantId: c.tenantId, storeId: c.storeId });
  }

  @Post('dead-letters/replay')
  async replayDeadLetters(@Req() req: Request, @Body() body: unknown) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'admin')) throw new ForbiddenException('PERMISSION_DENIED');
    const parsed = parseInput(
      z.object({ ids: z.array(z.string().uuid()).min(1).max(100).optional() }).strict(),
      body ?? {},
    );
    return replayDeadLetterOutbox(this.db, { tenantId: c.tenantId, storeId: c.storeId, ids: parsed.ids });
  }
}
