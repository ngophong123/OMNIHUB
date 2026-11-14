ALTER TABLE "CashMovement" ADD COLUMN "refundId" UUID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_refund_unique" UNIQUE ("tenantId","storeId","refundId");
