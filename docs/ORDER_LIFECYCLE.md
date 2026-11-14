# Order lifecycle and command contract

Order: ACCEPTED -> COMPLETED or CANCELLED. Item: PENDING -> PREPARING -> READY -> HANDED_OFF, or any unpaid noncancelled state -> CANCELLED with role restrictions. Kitchen and fulfillment projections are derived independently: READY means prepared; HANDED_OFF means served. Payment remains UNPAID until successful full cash settlement.

Each line expands to unit-level items. Order is cancelled only when every unit is cancelled. Completion requires at least one handed-off unit, no remaining active preparation, and a full payment. No paid-order editing/cancellation in MVP.

## Operation specifications

Every command requires an authenticated active membership, exact Origin, UUID Idempotency-Key, schema-valid body, and store-scoped lookup. Each successful command writes Audit(actor, action, entity, correlationId), versioned Outbox event and receipt in ONE serializable database transaction. Replays return original receipt; mismatched key payload gets 409; missing target gets 404 without data disclosure. Serialization conflicts retry at most four times; business rejection rolls back everything. Invalid transition/version gets 409, forbidden action 403, bad input 400. Acceptance tests named below are mandatory; TESTING.md records execution status separately.

| Operation | Preconditions / permission | Transition / side effects | Audit / event | Acceptance tests |
|---|---|---|---|---|
| Accept order | POS permission; active products, valid recipes, sufficient all ingredients | Create ACCEPTED order, PENDING units/tickets; snapshot prices/recipes; increment reserved atomically; reserve ledger | order.accepted / order.accepted | server price authority; last portion race; overlapping ingredients; rollback no residue; duplicate command; changed-payload replay |
| START unit | kitchen permission; unpaid; PENDING; expected order version | PREPARING; consume this unit's reservations; onHand and reserved decrease; ledger | item.start / kitchen.item.started | no double consumption; stale version; recipe edits do not change historical consumption |
| READY unit | kitchen permission; PREPARING; version | READY; no stock or money changes | item.ready / kitchen.item.ready | starting required; one unit cannot complete other units |
| HANDOFF unit | handoff permission; READY; version | HANDED_OFF; fulfillment projection updated | item.handoff / kitchen.item.handed_off | not before READY; mixed unit state |
| CANCEL unit | cashier for PENDING; manager/owner otherwise; unpaid; version | CANCELLED; release if unstarted, classify waste if started; adjust due from snapshots; all-cancelled order -> CANCELLED | item.cancel / order.item.cancelled | partial cancellation; role escalation; zero restoration after start; no paid cancellation |
| CASH settle | cashier permission; ACCEPTED; all surviving units HANDED_OFF; tender >= due; version | Payment row, COMPLETED, PAID; calculate change; businessDate from server store clock | payment.cash / payment.confirmed | underpayment; duplicate/new-key double settlement; cancelled units excluded; business cutoff |
| Stock adjustment | inventory permission; reason; nonzero base-unit delta; enough onHand after change to cover reserved | onHand += delta; append adjustment ledger, no silent reservation release | inventory.adjust / inventory.adjusted | reserved floor; forbidden cashier; ledger reconciliation |

Audit/outbox failures roll back business changes. Audit action uses the same canonical event name as outbox; short names in the operation table identify the business action. Rejected attempts are surfaced through HTTP logs without persisting a success audit. A separate security rejection audit stream is a pilot-hardening task. Correlation IDs pass through command audit/outbox and HTTP response.
