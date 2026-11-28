import { Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { CatalogOperations } from '../../catalog-operations';
import { PRISMA_DB } from '../../shared/database.module';
import { CatalogController } from './catalog.controller';

@Module({
  controllers: [CatalogController],
  providers: [
    {
      provide: CatalogOperations,
      useFactory: (database: PrismaClient) => new CatalogOperations(database),
      inject: [PRISMA_DB],
    },
  ],
  exports: [CatalogOperations],
})
export class CatalogModule {}
