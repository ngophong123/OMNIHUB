-- 1. Financial integrity: allow refunds against settled payments on partially paid (ACCEPTED) orders
--    while preserving strict COMPLETED and CANCELLED invariants.
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "order_payment_terminal";
ALTER TABLE "Order" ADD CONSTRAINT "order_payment_terminal" CHECK (
  (status = 'COMPLETED' AND "paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'))
  OR (status = 'ACCEPTED' AND "paymentStatus" IN ('UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'))
  OR (status = 'CANCELLED' AND "paymentStatus" = 'UNPAID')
);

-- 2. CashShift state machine integrity: disallow CLOSED shifts with unapproved discrepancies
--    and reject DELETE on any CashShift row.
ALTER TABLE "CashShift" DROP CONSTRAINT IF EXISTS "CashShift_discrepancy_approval_check";
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_discrepancy_approval_check" CHECK (
  ("approvalStatus" = 'PENDING' AND status = 'CLOSING' AND discrepancy <> 0 AND length(trim(coalesce(reason, ''))) >= 5 AND "approvedBy" IS NULL AND "approvedAt" IS NULL)
  OR ("approvalStatus" = 'APPROVED' AND status = 'CLOSED' AND discrepancy <> 0 AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL)
  OR ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy = 0 AND status IN ('CLOSED', 'CLOSING') AND "approvedBy" IS NULL AND "approvedAt" IS NULL)
  OR ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy IS NULL AND status = 'OPEN' AND "approvedBy" IS NULL AND "approvedAt" IS NULL)
);

CREATE OR REPLACE FUNCTION protect_closed_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash shift deletion is forbidden';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'closed cash shift is immutable';
  END IF;
  IF OLD.status = 'OPEN' AND NEW.status NOT IN ('OPEN', 'CLOSING') THEN
    RAISE EXCEPTION 'invalid cash shift state transition';
  END IF;
  IF OLD.status = 'CLOSING' AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'invalid cash shift state transition';
  END IF;
  IF OLD.status = 'CLOSING' AND (
    NEW."expectedAmount" IS DISTINCT FROM OLD."expectedAmount"
    OR NEW."countedAmount" IS DISTINCT FROM OLD."countedAmount"
    OR NEW.discrepancy IS DISTINCT FROM OLD.discrepancy
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW."closingAt" IS DISTINCT FROM OLD."closingAt"
  ) THEN
    RAISE EXCEPTION 'cash close snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Durable Outbox retry, exponential backoff, and Dead Letter Queue state.
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "deadLetteredAt" TIMESTAMPTZ;

ALTER TABLE "Outbox" DROP CONSTRAINT IF EXISTS "Outbox_retry_integrity";
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_retry_integrity" CHECK (
  "attempts" >= 0 AND "maxAttempts" >= 1 AND NOT ("deliveredAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL)
);

-- 4. Missing Payment(tenantId, storeId, orderId, createdAt) index and hot-path indexes.
CREATE INDEX IF NOT EXISTS "Payment_tenantId_storeId_orderId_createdAt_idx"
  ON "Payment"("tenantId", "storeId", "orderId", "createdAt");
CREATE INDEX IF NOT EXISTS "Refund_tenantId_storeId_paymentId_status_idx"
  ON "Refund"("tenantId", "storeId", "paymentId", "status");
CREATE INDEX IF NOT EXISTS "Refund_tenantId_storeId_status_businessDate_idx"
  ON "Refund"("tenantId", "storeId", "status", "businessDate");
CREATE INDEX IF NOT EXISTS "Movement_tenantId_storeId_createdAt_idx"
  ON "Movement"("tenantId", "storeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "CashMovement_tenantId_storeId_paymentId_kind_idx"
  ON "CashMovement"("tenantId", "storeId", "paymentId", "kind");
CREATE INDEX IF NOT EXISTS "Audit_tenantId_storeId_entityId_createdAt_idx"
  ON "Audit"("tenantId", "storeId", "entityId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "Session_tenantId_storeId_userId_expiresAt_idx"
  ON "Session"("tenantId", "storeId", "userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "StoreInvitation_pending_email_idx"
  ON "StoreInvitation"("tenantId", "storeId", lower("email"))
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Outbox_pending_ready_idx"
  ON "Outbox"("nextAttemptAt", "createdAt", id)
  WHERE "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Outbox_dead_letter_idx"
  ON "Outbox"("deadLetteredAt" DESC)
  WHERE "deadLetteredAt" IS NOT NULL;
