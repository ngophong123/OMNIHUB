ALTER TABLE "CashShift" DROP CONSTRAINT "CashShift_discrepancy_approval_check";
ALTER TABLE "CashShift" ADD CONSTRAINT "CashShift_discrepancy_approval_check" CHECK (
 ("approvalStatus" = 'PENDING' AND status = 'CLOSING' AND discrepancy <> 0 AND length(trim(coalesce(reason,''))) >= 5) OR
 ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy IS DISTINCT FROM 0 AND status <> 'CLOSING') OR
 ("approvalStatus" = 'APPROVED' AND status = 'CLOSED' AND discrepancy <> 0 AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL) OR
 ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy = 0 AND status IN ('CLOSED','CLOSING','OPEN')) OR
 ("approvalStatus" = 'NOT_REQUIRED' AND discrepancy IS NULL AND status = 'OPEN')
);
CREATE OR REPLACE FUNCTION protect_closed_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'closed cash shift is immutable'; END IF;
 IF OLD.status = 'OPEN' AND NEW.status NOT IN ('OPEN','CLOSING') THEN RAISE EXCEPTION 'invalid cash shift state transition'; END IF;
 IF OLD.status = 'CLOSING' AND NEW.status <> 'CLOSED' THEN RAISE EXCEPTION 'invalid cash shift state transition'; END IF;
 IF OLD.status = 'CLOSING' AND (NEW."expectedAmount" IS DISTINCT FROM OLD."expectedAmount" OR NEW."countedAmount" IS DISTINCT FROM OLD."countedAmount" OR NEW.discrepancy IS DISTINCT FROM OLD.discrepancy OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW."closingAt" IS DISTINCT FROM OLD."closingAt") THEN RAISE EXCEPTION 'cash close snapshot is immutable'; END IF;
 RETURN NEW;
END; $$;
