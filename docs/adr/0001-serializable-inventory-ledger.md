# ADR-0001: Serializable Inventory Reservations and Append-Only Ledger

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

Concurrent POS cashiers and QR dine-in guests can order menu items that share the same ingredients at the same instant. Standard read-modify-write stock checks under `ReadCommitted` isolation allow race conditions that oversell ingredients, leave negative available stock, or cause deadlocks when two orders lock ingredients in opposite orders. Financial and stock disputes also require an auditable trail that cannot be silently rewritten.

## Decision

1. Execute multi-row order acceptance, item state transitions, cancellations, payments, and shift mutations inside PostgreSQL `Serializable` transactions through the shared `CommandBus` (`apps/api/src/commands.ts`), which retries recognized Prisma `P2034`/`P2002` errors and selected transient SQLSTATE `40001`/`40P01` errors (including Prisma `P2010` wrappers) for up to 4 total attempts before returning `409` (with `externalReference` uniqueness conflicts handled separately). A separate helper (`runSerializableTransactionWithRetry` in `apps/api/src/database.ts`) is used in kitchen-device registration, station assignment, and revocation paths (`apps/api/src/http.ts`) and retries strictly on Prisma `P2034` for up to 3 total attempts with bounded jittered backoff.
2. Compute aggregated ingredient requirements per order, sort by `ingredientId` ascending, and perform atomic conditional SQL updates (`UPDATE "Balance" SET "reserved" = "reserved" + qty WHERE "onHand" - "reserved" >= qty`).
3. Enforce invariants inside PostgreSQL via `CHECK` constraints (`onHand >= reserved AND reserved >= 0`, exact `Movement` delta rules) and `BEFORE UPDATE OR DELETE` triggers (`reject_ledger_mutation()`) on `Movement`, `Audit`, and `Payment`.
4. Store ingredient quantities as `Decimal(18,3)` in base units (`g`, `ml`, `piece`) and currency amounts as integer VND.

## Consequences

- **Positive:** Overselling is prevented at both the application and database layers; deterministic ingredient sorting establishes a consistent ordering for inventory ingredient reservation updates within this flow (it does not establish system-wide deadlock freedom across Order, Payment, and CashShift transactions); ledger tampering is blocked even against accidental updates.
- **Trade-offs:** High-contention writes on the same ingredient or shift can return `P2034` and require bounded retries or client-side idempotent retries (`409` with the same `Idempotency-Key`). Because `Movement` and `Payment` rows are immutable, reversals must be modeled as compensating entries (`RELEASE`, `WASTE`, `Refund`, `CashMovement`).
