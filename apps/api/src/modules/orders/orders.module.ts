import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Operations } from '../../operations';
import { PRISMA_DB } from '../../shared/database.module';
import { OrdersController } from './orders.controller';

@Module({
  controllers: [OrdersController],
  providers: [
    {
      provide: Operations,
      useFactory: (database: PrismaClient) => new Operations(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [Operations],
})
export class OrdersModule {}
