import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { OrdersModule } from '../orders/orders.module';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [OrdersModule, CatalogModule],
  controllers: [InventoryController],
})
export class InventoryModule {}
