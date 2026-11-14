ALTER TABLE "Balance" ADD CONSTRAINT "balance_nonnegative_available" CHECK ("onHand" >= "reserved" AND "reserved" >= 0);
ALTER TABLE "RecipeItem" ADD CONSTRAINT "recipe_positive" CHECK (quantity > 0);
ALTER TABLE "Reservation" ADD CONSTRAINT "reservation_positive" CHECK (quantity > 0);
ALTER TABLE "Product" ADD CONSTRAINT "product_price_range" CHECK (price >= 0 AND price <= 1000000000 AND "recipeVersion" >= 1);
ALTER TABLE "OrderItem" ADD CONSTRAINT "snapshot_price_range" CHECK ("unitPrice" >= 0 AND "unitPrice" <= 1000000000 AND "recipeVersion" >= 1);
ALTER TABLE "Order" ADD CONSTRAINT "order_money_and_version" CHECK (total >= 0 AND total <= 1000000000 AND version >= 1);
ALTER TABLE "Order" ADD CONSTRAINT "order_payment_status" CHECK ("paymentStatus" IN ('UNPAID','PAID'));
ALTER TABLE "Order" ADD CONSTRAINT "order_payment_terminal" CHECK ((status = 'COMPLETED') = ("paymentStatus" = 'PAID'));
ALTER TABLE "Payment" ADD CONSTRAINT "cash_amounts" CHECK (amount >= 0 AND amount <= 1000000000 AND tendered >= amount AND tendered <= 1000000000 AND change = tendered - amount AND method = 'CASH');
ALTER TABLE "Store" ADD CONSTRAINT "store_business_clock" CHECK (timezone = 'Asia/Ho_Chi_Minh' AND "dayStart" >= 0 AND "dayStart" < 1440);
ALTER TABLE "Ingredient" ADD CONSTRAINT "ingredient_base_unit" CHECK (unit IN ('g','ml','piece'));
ALTER TABLE "Movement" ADD CONSTRAINT "movement_kind" CHECK (kind IN ('RESERVE','CONSUME','RELEASE','WASTE','ADJUST'));
ALTER TABLE "Movement" ADD CONSTRAINT "movement_effect" CHECK (
  (kind = 'RESERVE' AND "onHandDelta" = 0 AND "reservedDelta" > 0 AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL) OR
  (kind = 'CONSUME' AND "onHandDelta" < 0 AND "reservedDelta" = "onHandDelta" AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL) OR
  (kind = 'RELEASE' AND "onHandDelta" = 0 AND "reservedDelta" < 0 AND "wasteQuantity" = 0 AND "itemId" IS NOT NULL) OR
  (kind = 'WASTE' AND "onHandDelta" = 0 AND "reservedDelta" = 0 AND "wasteQuantity" > 0 AND "itemId" IS NOT NULL) OR
  (kind = 'ADJUST' AND "onHandDelta" <> 0 AND "reservedDelta" = 0 AND "wasteQuantity" = 0 AND reason IS NOT NULL)
);
-- Append-only ledger and audits. Deliberate administrative repair needs a separate controlled migration.
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable operational ledger'; END;
$$;
CREATE TRIGGER movement_immutable BEFORE UPDATE OR DELETE ON "Movement" FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "Audit" FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
