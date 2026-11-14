# Cash shifts and reconciliation

All monetary values are integer VND. PostgreSQL is authoritative; every mutation uses a UUIDv4 idempotency key, a serializable transaction, an immutable audit record and a transactional outbox event.

## Lifecycle and assignment

`OPEN → CLOSING → CLOSED` is the only lifecycle. Opening records a store-scoped register, assigned cashier, opening float, open timestamp and business date using that store's configured timezone and business-day cutoff. Cashiers may open for themselves; an owner or manager may assign an active cashier, owner or manager who belongs to the same store. Each store receives a `Register 1`; owners and managers can add further registers.

Only one non-closed shift can occupy a register or cashier in a store. For handover, the outgoing cashier counts and closes their shift first; an incoming cashier then opens a new shift. A closed shift cannot be edited or reopened. PostgreSQL constraints and triggers enforce the lifecycle and freeze its close snapshot.

## Cash ledger and expected balance

Expected cash is calculated as:

`opening float + cash payment amount + cash-in + correction-in − cash-out − refund − correction-out`

`Payment.amount` is used once because it is the net amount retained after change; `tendered` is never added on top. Sales remain in the immutable `Payment` table and are linked to their shift. Other cash effects are append-only `CashMovement` entries. A refund must reference a payment in the same shift and cannot exceed its unrefunded amount. Cash-out, refund and correction-out cannot drive the expected drawer below zero.

Cash payment and drawer-movement commands lock and increment the open shift in the same transaction. Closing reads the payment and movement ledger and changes the shift in that transaction. A concurrent payment/movement either commits before the close snapshot or retries/fails against the closed shift; it cannot be silently omitted. Duplicate commands replay their stored result and do not repeat a financial effect.

## Closing and exceptions

Closing records the physical count and computed expected balance. A matching count transitions atomically through `CLOSING` to `CLOSED`. A nonzero difference requires a reason and leaves the shift `CLOSING` with approval `PENDING`; the register and cashier remain unavailable until an owner or manager approves. Approval records the manager and timestamp, then closes the shift. The close snapshot cannot be changed while awaiting approval. The manager's note and the cashier's discrepancy reason remain in immutable audit history.

There is no reopen or manager-reject action. If the count or recorded movements are wrong while approval is pending, the shift remains locked for manager review; correcting historical entries is not allowed. After closure, use a reasoned compensating correction in a later open shift. This release records refunds as compensating cash movements and never edits or deletes the original payment.

## Late and failed payments; historical records

A payment requires a live shift assigned to the acting cashier. If a shift has closed, the payment request is rejected. A genuinely late settlement must be handled in a new shift with a reasoned correction and an order/payment reference; the old shift and its snapshots stay closed. If payment processing fails before commit, the order remains unpaid and no payment or cash movement is written; retry with the same idempotency key and identical payload. Reusing a key with different data is rejected.

Payments written before this migration remain unchanged and have no shift link. They remain visible in store payment/report history as legacy payments. New payments through the cash API require a shift and carry its `cashShiftId`; no historical payment is backfilled or reattributed.

The shift business date is captured when it opens. Each sale also retains the payment business date calculated at payment time, so a shift crossing the configured day boundary can contain payments belonging to more than one business date without moving cash between shifts.
