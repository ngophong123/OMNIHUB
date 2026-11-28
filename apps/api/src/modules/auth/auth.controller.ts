import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { loginSchema } from '@omnihub/contracts';
import { login } from '../../auth';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, parseInput, publishOutboxRevocation } from '../../shared/http-helpers';

@Controller('auth')
export class AuthController {
  constructor(@Inject(PRISMA_DB) private readonly db: PrismaClient) {}

  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const data = parseInput(loginSchema, body);
    const session = await login(this.db, data.email, data.password, data.storeId);
    res.cookie('session', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.SESSION_SECURE !== 'false',
      expires: session.expiresAt,
      path: '/',
    });
    return { expiresAt: session.expiresAt };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    const store = await this.db.store.findFirstOrThrow({
      where: { id: c.storeId, tenantId: c.tenantId },
      select: { name: true },
    });
    return { userId: c.userId, tenantId: c.tenantId, storeId: c.storeId, role: c.role, storeName: store.name };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const c = await authenticateRequest(this.db, req);
    const revokedEvent = await this.db.$transaction(async tx => {
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
    res.clearCookie('session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.SESSION_SECURE !== 'false',
    });
    return { ok: true };
  }
}
