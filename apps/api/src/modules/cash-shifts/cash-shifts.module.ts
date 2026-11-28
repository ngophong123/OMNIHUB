import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { CashShifts } from '../../cash-shifts';
import { PRISMA_DB } from '../../shared/database.module';
import { CashShiftsController } from './cash-shifts.controller';

@Module({
  controllers: [CashShiftsController],
  providers: [
    {
      provide: CashShifts,
      useFactory: (database: PrismaClient) => new CashShifts(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [CashShifts],
})
export class CashShiftsModule {}
