-- AlterTable
ALTER TABLE "Audit" ADD COLUMN     "details" JSONB;

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "lowStockThreshold" DECIMAL(18,3) NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Movement" ADD COLUMN     "receiptId" UUID;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "selectionSnapshot" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "manualAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "recipeMultiplier" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "minSelections" INTEGER NOT NULL DEFAULT 0,
    "maxSelections" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Modifier" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierRecipeItem" (
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "modifierId" UUID NOT NULL,
    "ingredientId" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "ModifierRecipeItem_pkey" PRIMARY KEY ("modifierId","ingredientId")
);

-- CreateTable
CREATE TABLE "StockReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Category_tenantId_storeId_deletedAt_name_idx" ON "Category"("tenantId", "storeId", "deletedAt", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_storeId_id_key" ON "Category"("tenantId", "storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeRevision_productId_version_key" ON "RecipeRevision"("productId", "version");

-- CreateIndex
CREATE INDEX "ProductVariant_tenantId_storeId_productId_idx" ON "ProductVariant"("tenantId", "storeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_tenantId_storeId_id_key" ON "ProductVariant"("tenantId", "storeId", "id");

-- CreateIndex
CREATE INDEX "ModifierGroup_tenantId_storeId_productId_idx" ON "ModifierGroup"("tenantId", "storeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_tenantId_storeId_id_key" ON "ModifierGroup"("tenantId", "storeId", "id");

-- CreateIndex
CREATE INDEX "Modifier_tenantId_storeId_groupId_idx" ON "Modifier"("tenantId", "storeId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Modifier_tenantId_storeId_id_key" ON "Modifier"("tenantId", "storeId", "id");

-- CreateIndex
CREATE INDEX "StockReceipt_tenantId_storeId_createdAt_idx" ON "StockReceipt"("tenantId", "storeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockReceipt_tenantId_storeId_id_key" ON "StockReceipt"("tenantId", "storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockReceipt_tenantId_storeId_reference_key" ON "StockReceipt"("tenantId", "storeId", "reference");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_storeId_categoryId_fkey" FOREIGN KEY ("tenantId", "storeId", "categoryId") REFERENCES "Category"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_tenantId_storeId_receiptId_fkey" FOREIGN KEY ("tenantId", "storeId", "receiptId") REFERENCES "StockReceipt"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_tenantId_storeId_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeRevision" ADD CONSTRAINT "RecipeRevision_tenantId_storeId_productId_fkey" FOREIGN KEY ("tenantId", "storeId", "productId") REFERENCES "Product"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_tenantId_storeId_productId_fkey" FOREIGN KEY ("tenantId", "storeId", "productId") REFERENCES "Product"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_tenantId_storeId_productId_fkey" FOREIGN KEY ("tenantId", "storeId", "productId") REFERENCES "Product"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_tenantId_storeId_groupId_fkey" FOREIGN KEY ("tenantId", "storeId", "groupId") REFERENCES "ModifierGroup"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierRecipeItem" ADD CONSTRAINT "ModifierRecipeItem_tenantId_storeId_modifierId_fkey" FOREIGN KEY ("tenantId", "storeId", "modifierId") REFERENCES "Modifier"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierRecipeItem" ADD CONSTRAINT "ModifierRecipeItem_tenantId_storeId_ingredientId_fkey" FOREIGN KEY ("tenantId", "storeId", "ingredientId") REFERENCES "Ingredient"("tenantId", "storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_tenantId_storeId_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the append-only inventory ledger valid when stock is received.
ALTER TABLE "Movement" DROP CONSTRAINT "movement_kind";
ALTER TABLE "Movement" ADD CONSTRAINT "movement_kind" CHECK (kind IN ('RESERVE','CONSUME','RELEASE','WASTE','ADJUST','RECEIPT'));
ALTER TABLE "Movement" DROP CONSTRAINT "movement_effect";
ALTER TABLE "Movement" ADD CONSTRAINT "movement_effect" CHECK (
  (kind = 'RESERVE' AND "onHandDelta" = 0 AND "reservedDelta" > 0 AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL AND "receiptId" IS NULL) OR
  (kind = 'CONSUME' AND "onHandDelta" < 0 AND "reservedDelta" = "onHandDelta" AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL AND "receiptId" IS NULL) OR
  (kind = 'RELEASE' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL AND "receiptId" IS NULL) OR
  (kind = 'WASTE' AND "onHandDelta" = 0 AND "reservedDelta" = 0 AND "wasteQuantity" > 0 AND "itemId" IS NOT NULL AND "receiptId" IS NULL) OR
  (kind = 'ADJUST' AND "onHandDelta" <> 0 AND "reservedDelta" = 0 AND "wasteQuantity" = 0 AND reason IS NOT NULL AND "itemId" IS NULL AND "receiptId" IS NULL) OR
  (kind = 'RECEIPT' AND "onHandDelta" > 0 AND "reservedDelta" = 0 AND "wasteQuantity" = 0 AND "itemId" IS NULL AND "receiptId" IS NOT NULL)
);

ALTER TABLE "Category" ADD CONSTRAINT "category_version_positive" CHECK ("version" >= 1);
ALTER TABLE "Ingredient" ADD CONSTRAINT "ingredient_admin_range" CHECK ("version" >= 1 AND "lowStockThreshold" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "product_admin_version" CHECK ("version" >= 1);
ALTER TABLE "Station" ADD CONSTRAINT "station_version_positive" CHECK ("version" >= 1);
ALTER TABLE "RecipeRevision" ADD CONSTRAINT "recipe_revision_version_positive" CHECK ("version" >= 1);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "variant_valid_values" CHECK (price BETWEEN 0 AND 1000000000 AND "recipeMultiplier" > 0 AND "recipeMultiplier" <= 1000 AND "version" >= 1);
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "modifier_selection_range" CHECK ("minSelections" >= 0 AND "maxSelections" >= 1 AND "minSelections" <= "maxSelections" AND "version" >= 1);
ALTER TABLE "Modifier" ADD CONSTRAINT "modifier_valid_values" CHECK ("priceDelta" BETWEEN 0 AND 1000000000 AND "version" >= 1);
ALTER TABLE "ModifierRecipeItem" ADD CONSTRAINT "modifier_recipe_positive" CHECK (quantity > 0);
