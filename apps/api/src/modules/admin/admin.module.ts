import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PilotAdmin } from '../../pilot-admin';
import { PRISMA_DB } from '../../shared/database.module';
import { AdminController } from './admin.controller';

@Module({
  controllers: [AdminController],
  providers: [
    {
      provide: PilotAdmin,
      useFactory: (database: PrismaClient) => new PilotAdmin(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [PilotAdmin],
})
export class AdminModule {}
