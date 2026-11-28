import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { QrOrdering } from '../../qr-ordering';
import { PRISMA_DB } from '../../shared/database.module';
import { OrdersModule } from '../orders/orders.module';
import { QrOrderingController } from './qr-ordering.controller';

@Module({
  imports: [OrdersModule],
  controllers: [QrOrderingController],
  providers: [
    {
      provide: QrOrdering,
      useFactory: (database: PrismaClient) => new QrOrdering(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [QrOrdering],
})
export class QrOrderingModule {}
