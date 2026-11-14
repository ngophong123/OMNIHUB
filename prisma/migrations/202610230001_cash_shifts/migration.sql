CREATE TABLE "CashRegister" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "storeId" uuid NOT NULL,
  name text NOT NULL, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  CONSTRAINT "CashRegister_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", id),
  CONSTRAINT "CashRegister_tenant_store_id_key" UNIQUE ("tenantId", "storeId", id),
  CONSTRAINT "CashRegister_name_key" UNIQUE ("tenantId", "storeId", name),
  CONSTRAINT "CashRegister_name_nonempty" CHECK (length(trim(name)) BETWEEN 1 AND 80)
);
CREATE TABLE "CashShift" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "storeId" uuid NOT NULL,
  "registerId" uuid NOT NULL, "cashierId" uuid NOT NULL, status text NOT NULL DEFAULT 'OPEN',
  "approvalStatus" text NOT NULL DEFAULT 'NOT_REQUIRED', "openingAmount" integer NOT NULL,
  "expectedAmount" integer, "countedAmount" integer, discrepancy integer, reason text,
  "openedAt" timestamptz NOT NULL DEFAULT now(), "closingAt" timestamptz, "closedAt" timestamptz,
  "approvedBy" uuid, "approvedAt" timestamptz, version integer NOT NULL DEFAULT 1,
  CONSTRAINT "CashShift_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", id),
  CONSTRAINT "CashShift_register_fkey" FOREIGN KEY ("tenantId", "storeId", "registerId") REFERENCES "CashRegister"("tenantId", "storeId", id),
  CONSTRAINT "CashShift_tenant_store_id_key" UNIQUE ("tenantId", "storeId", id),
  CONSTRAINT "CashShift_status_check" CHECK (status IN ('OPEN','CLOSING','CLOSED')),
  CONSTRAINT "CashShift_approval_check" CHECK ("approvalStatus" IN ('NOT_REQUIRED','PENDING','APPROVED')),
  CONSTRAINT "CashShift_money_check" CHECK ("openingAmount" BETWEEN 0 AND 1000000000 AND ("expectedAmount" IS NULL OR "expectedAmount" BETWEEN 0 AND 1000000000) AND ("countedAmount" IS NULL OR "countedAmount" BETWEEN 0 AND 1000000000) AND (discrepancy IS NULL OR discrepancy = "countedAmount" - "expectedAmount")),
  CONSTRAINT "CashShift_lifecycle_check" CHECK ((status = 'OPEN' AND "closingAt" IS NULL AND "closedAt" IS NULL AND "expectedAmount" IS NULL) OR (status = 'CLOSING' AND "closingAt" IS NOT NULL AND "closedAt" IS NULL AND "expectedAmount" IS NOT NULL AND "countedAmount" IS NOT NULL) OR (status = 'CLOSED' AND "closingAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "expectedAmount" IS NOT NULL AND "countedAmount" IS NOT NULL)),
  CONSTRAINT "CashShift_discrepancy_approval_check" CHECK (("approvalStatus" = 'PENDING' AND status = 'CLOSING' AND discrepancy <> 0 AND length(trim(coalesce(reason,''))) >= 5) OR ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy IS DISTINCT FROM 0 AND status <> 'CLOSING') OR ("approvalStatus" = 'APPROVED' AND status = 'CLOSED' AND discrepancy <> 0 AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL) OR ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy = 0 AND status IN ('CLOSED','OPEN')) OR ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy IS NULL AND status = 'OPEN'))
);
CREATE UNIQUE INDEX "CashShift_one_open_register" ON "CashShift"("tenantId", "storeId", "registerId") WHERE status <> 'CLOSED';
CREATE UNIQUE INDEX "CashShift_one_open_cashier" ON "CashShift"("tenantId", "storeId", "cashierId") WHERE status <> 'CLOSED';
CREATE INDEX "CashShift_history_idx" ON "CashShift"("tenantId", "storeId", status, "openedAt");
CREATE TABLE "CashMovement" (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "storeId" uuid NOT NULL, "shiftId" uuid NOT NULL,
 "commandKey" text NOT NULL, kind text NOT NULL, amount integer NOT NULL, reason text NOT NULL,
 "paymentId" uuid, "actorId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "CashMovement_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", id),
 CONSTRAINT "CashMovement_shift_fkey" FOREIGN KEY ("tenantId", "storeId", "shiftId") REFERENCES "CashShift"("tenantId", "storeId", id),
 CONSTRAINT "CashMovement_tenant_store_command_key" UNIQUE ("tenantId", "storeId", "commandKey"),
 CONSTRAINT "CashMovement_kind_check" CHECK (kind IN ('CASH_IN','CASH_OUT','REFUND','CORRECTION_IN','CORRECTION_OUT')),
 CONSTRAINT "CashMovement_amount_check" CHECK (amount BETWEEN 1 AND 1000000000 AND length(trim(reason)) BETWEEN 5 AND 300)
);
CREATE INDEX "CashMovement_history_idx" ON "CashMovement"("tenantId", "storeId", "shiftId", "createdAt");
ALTER TABLE "Payment" ADD COLUMN "cashShiftId" uuid;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cashShift_fkey" FOREIGN KEY ("tenantId", "storeId", "cashShiftId") REFERENCES "CashShift"("tenantId", "storeId", id);
CREATE INDEX "Payment_cashShift_idx" ON "Payment"("tenantId", "storeId", "cashShiftId");
INSERT INTO "CashRegister" ("tenantId", "storeId", name)
SELECT "tenantId", id, 'Register 1' FROM "Store";
CREATE FUNCTION reject_cash_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable cash ledger'; END; $$;
CREATE TRIGGER "CashMovement_immutable" BEFORE UPDATE OR DELETE ON "CashMovement" FOR EACH ROW EXECUTE FUNCTION reject_cash_movement_mutation();
CREATE FUNCTION protect_closed_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'closed cash shift is immutable'; END IF;
 IF OLD.status = 'CLOSING' AND (NEW."expectedAmount" IS DISTINCT FROM OLD."expectedAmount" OR NEW."countedAmount" IS DISTINCT FROM OLD."countedAmount" OR NEW.discrepancy IS DISTINCT FROM OLD.discrepancy OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW."closingAt" IS DISTINCT FROM OLD."closingAt") THEN RAISE EXCEPTION 'cash close snapshot is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "CashShift_protect_closed" BEFORE UPDATE OR DELETE ON "CashShift" FOR EACH ROW EXECUTE FUNCTION protect_closed_cash_shift();
CREATE FUNCTION create_default_cash_register() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO "CashRegister" ("tenantId", "storeId", name) VALUES (NEW."tenantId", NEW.id, 'Register 1') ON CONFLICT ("tenantId", "storeId", name) DO NOTHING; RETURN NEW; END; $$;
CREATE TRIGGER "Store_default_cash_register" AFTER INSERT ON "Store" FOR EACH ROW EXECUTE FUNCTION create_default_cash_register();
ALTER TABLE "CashShift" ADD COLUMN "businessDate" text;
UPDATE "CashShift" s SET "businessDate" = to_char((s."openedAt" AT TIME ZONE st.timezone - make_interval(mins => st."dayStart"))::date, 'YYYY-MM-DD') FROM "Store" st WHERE st.id = s."storeId" AND st."tenantId" = s."tenantId";
ALTER TABLE "CashShift" ALTER COLUMN "businessDate" SET NOT NULL;
