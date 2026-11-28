import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Payments } from '../../payments';
import { PRISMA_DB } from '../../shared/database.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: Payments,
      useFactory: (database: PrismaClient) => new Payments(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [Payments],
})
export class PaymentsModule {}
