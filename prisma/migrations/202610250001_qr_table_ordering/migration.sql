ALTER TABLE "Store" ADD COLUMN "qrOrderingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "imageUrl" TEXT;

CREATE TABLE "RestaurantTable" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "qrEnabled" BOOLEAN NOT NULL DEFAULT true,
  "qrTokenHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RestaurantTable_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RestaurantTable_qrTokenHash_key" UNIQUE ("qrTokenHash"),
  CONSTRAINT "RestaurantTable_tenantId_storeId_id_key" UNIQUE ("tenantId", "storeId", "id"),
  CONSTRAINT "RestaurantTable_tenantId_storeId_name_key" UNIQUE ("tenantId", "storeId", "name")
);
CREATE INDEX "RestaurantTable_tenantId_storeId_active_name_idx" ON "RestaurantTable"("tenantId", "storeId", "active", "name");

CREATE TABLE "TableSession" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "tableId" UUID NOT NULL,
  "sessionTokenHash" TEXT NOT NULL,
  "qrCredentialHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TableSession_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TableSession_table_fkey" FOREIGN KEY ("tenantId", "storeId", "tableId") REFERENCES "RestaurantTable"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TableSession_sessionTokenHash_key" UNIQUE ("sessionTokenHash"),
  CONSTRAINT "TableSession_tenantId_storeId_id_key" UNIQUE ("tenantId", "storeId", "id"),
  CONSTRAINT "TableSession_status_check" CHECK ("status" IN ('OPEN','CLOSED','EXPIRED'))
);
CREATE INDEX "TableSession_tenantId_storeId_tableId_status_expiresAt_idx" ON "TableSession"("tenantId", "storeId", "tableId", "status", "expiresAt");

ALTER TABLE "Order" ADD COLUMN "tableSessionId" UUID;
ALTER TABLE "Order" ADD COLUMN "trackingTokenHash" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "preparationNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableSession_fkey" FOREIGN KEY ("tenantId", "storeId", "tableSessionId") REFERENCES "TableSession"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Order_trackingTokenHash_key" ON "Order"("trackingTokenHash");
CREATE INDEX "Order_tenantId_storeId_tableSessionId_createdAt_idx" ON "Order"("tenantId", "storeId", "tableSessionId", "createdAt");
