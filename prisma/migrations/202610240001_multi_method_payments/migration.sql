ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_orderId_key";
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_tenantId_storeId_orderId_key";
DROP TRIGGER IF EXISTS payment_immutable ON "Payment";
ALTER TABLE "Payment" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SETTLED';
ALTER TABLE "Payment" ADD COLUMN "externalReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Payment" ADD COLUMN "splitId" UUID;
UPDATE "Payment" SET "idempotencyKey" = 'legacy:' || id::text WHERE "idempotencyKey" IS NULL;
ALTER TABLE "Payment" ALTER COLUMN "idempotencyKey" SET NOT NULL;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_scope_id_key" UNIQUE ("tenantId", "storeId", id);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_scoped_idempotency_key" UNIQUE ("tenantId", "storeId", "idempotencyKey");
CREATE UNIQUE INDEX "Payment_external_reference_unique" ON "Payment" ("tenantId", "storeId", method, "externalReference") WHERE "externalReference" IS NOT NULL;
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "cash_amounts";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_money_integrity" CHECK (
  amount > 0 AND amount <= 1000000000 AND tendered >= amount AND tendered <= 1000000000 AND
  change = tendered - amount AND method IN ('CASH','BANK_TRANSFER','CARD') AND
  status IN ('PENDING','SETTLED','FAILED') AND
  ((method = 'CASH' AND ("cashShiftId" IS NOT NULL OR "idempotencyKey" LIKE 'legacy:%')) OR (method <> 'CASH' AND "cashShiftId" IS NULL))
);
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "order_payment_status";
ALTER TABLE "Order" ADD CONSTRAINT "order_payment_status" CHECK ("paymentStatus" IN ('UNPAID','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED'));
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "order_payment_terminal";
ALTER TABLE "Order" ADD CONSTRAINT "order_payment_terminal" CHECK ((status = 'COMPLETED') = ("paymentStatus" IN ('PAID','PARTIALLY_REFUNDED','REFUNDED')));
CREATE OR REPLACE FUNCTION payment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') OR OLD.status <> 'PENDING' OR NEW.status NOT IN ('SETTLED','FAILED') THEN
    RAISE EXCEPTION 'immutable payment except one pending status transition';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payment_immutable ON "Payment";
CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION payment_status_transition();

CREATE TABLE "Refund" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "storeId" UUID NOT NULL,
 "orderId" UUID NOT NULL, "paymentId" UUID NOT NULL, "itemId" UUID, amount INTEGER NOT NULL,
 reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'REQUESTED', "requestedBy" UUID NOT NULL,
 "approvedBy" UUID, "commandKey" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "approvedAt" TIMESTAMPTZ,
 CONSTRAINT "Refund_store_fkey" FOREIGN KEY ("tenantId","storeId") REFERENCES "Store"("tenantId",id),
 CONSTRAINT "Refund_order_fkey" FOREIGN KEY ("tenantId","storeId","orderId") REFERENCES "Order"("tenantId","storeId",id),
 CONSTRAINT "Refund_payment_fkey" FOREIGN KEY ("tenantId","storeId","paymentId") REFERENCES "Payment"("tenantId","storeId",id),
 CONSTRAINT "Refund_money_check" CHECK (amount > 0 AND amount <= 1000000000 AND length(trim(reason)) >= 5 AND status IN ('REQUESTED','APPROVED','REJECTED')),
 CONSTRAINT "Refund_scope_id_key" UNIQUE ("tenantId","storeId",id), CONSTRAINT "Refund_command_key" UNIQUE ("tenantId","storeId","commandKey")
);
CREATE INDEX "Refund_order_history" ON "Refund"("tenantId","storeId","orderId","createdAt");
CREATE TABLE "RefundDecision" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "storeId" UUID NOT NULL, "refundId" UUID NOT NULL,
 "actorId" UUID NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT "RefundDecision_refund_fkey" FOREIGN KEY ("tenantId","storeId","refundId") REFERENCES "Refund"("tenantId","storeId",id),
 CONSTRAINT "RefundDecision_unique" UNIQUE ("tenantId","storeId","refundId"),
 CONSTRAINT "RefundDecision_value" CHECK (decision IN ('APPROVED','REJECTED') AND length(trim(reason)) >= 5)
);
CREATE TRIGGER refund_decision_immutable BEFORE UPDATE OR DELETE ON "RefundDecision" FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE OR REPLACE FUNCTION refund_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - 'status' - 'approvedBy' - 'approvedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approvedBy' - 'approvedAt') OR OLD.status <> 'REQUESTED' OR NEW.status NOT IN ('APPROVED','REJECTED') THEN
   RAISE EXCEPTION 'immutable refund except one decision';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER refund_immutable BEFORE UPDATE OR DELETE ON "Refund" FOR EACH ROW EXECUTE FUNCTION refund_status_transition();

CREATE TABLE "BillSplit" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" UUID NOT NULL, "storeId" UUID NOT NULL, "orderId" UUID NOT NULL,
 label TEXT NOT NULL, amount INTEGER NOT NULL, "itemIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
 "commandKey" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT "BillSplit_store_fkey" FOREIGN KEY ("tenantId","storeId") REFERENCES "Store"("tenantId",id),
 CONSTRAINT "BillSplit_order_fkey" FOREIGN KEY ("tenantId","storeId","orderId") REFERENCES "Order"("tenantId","storeId",id),
 CONSTRAINT "BillSplit_scope_id_key" UNIQUE ("tenantId","storeId",id), CONSTRAINT "BillSplit_command_key" UNIQUE ("tenantId","storeId","commandKey"),
 CONSTRAINT "BillSplit_amount_check" CHECK (amount > 0 AND length(trim(label)) BETWEEN 1 AND 80)
);
CREATE INDEX "BillSplit_order_idx" ON "BillSplit"("tenantId","storeId","orderId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_split_fkey" FOREIGN KEY ("tenantId","storeId","splitId") REFERENCES "BillSplit"("tenantId","storeId",id);
CREATE TRIGGER bill_split_immutable BEFORE UPDATE OR DELETE ON "BillSplit" FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
