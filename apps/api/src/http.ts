import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CashShiftsModule } from './modules/cash-shifts/cash-shifts.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { OrdersModule } from './modules/orders/orders.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { QrOrderingModule } from './modules/qr-ordering/qr-ordering.module';
import { DatabaseModule } from './shared/database.module';

export { Errors } from './errors';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    OrdersModule,
    PaymentsModule,
    CashShiftsModule,
    CatalogModule,
    InventoryModule,
    KitchenModule,
    QrOrderingModule,
    OutboxModule,
    AdminModule,
  ],
})
export class AppModule {}
