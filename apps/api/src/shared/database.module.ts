import { Global, Module } from '@nestjs/common';
import { db } from '../database';

export const PRISMA_DB = Symbol('PRISMA_DB');

@Global()
@Module({
  providers: [{ provide: PRISMA_DB, useValue: db }],
  exports: [PRISMA_DB],
})
export class DatabaseModule {}
