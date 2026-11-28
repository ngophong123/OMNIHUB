import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { rateLimitRedisReady } from '../../rate-limit';
import { realtimeRedisReady } from '../../realtime';
import { PRISMA_DB } from '../../shared/database.module';

@Controller()
export class HealthController {
  constructor(@Inject(PRISMA_DB) private readonly db: PrismaClient) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    await this.db.$queryRaw`SELECT 1`;
    if (!(await rateLimitRedisReady())) {
      throw new ServiceUnavailableException('REDIS_REQUIRED_FOR_PROTECTED_RATE_LIMITS');
    }
    if (!(await realtimeRedisReady())) {
      throw new ServiceUnavailableException('REDIS_REQUIRED_FOR_REALTIME');
    }
    return { database: 'ok', redis: 'ok', realtime: 'ok' };
  }
}
