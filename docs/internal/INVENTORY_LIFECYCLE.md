# Inventory lifecycle

All quantities are Decimal(18,3) in an ingredient's base unit (g, ml or piece). Exact string parsing; no binary floating arithmetic for recipes or balances. MVP requires base units at authoring time; kg->g and l->ml conversion utilities can normalize exact decimal strings. Cross-dimension and density conversions are rejected; no global ml->g rule. Piece quantities may be fractional only where the ingredient's recipe policy explicitly allows it (MVP seeds whole pieces).

| Operation | onHand delta | reserved delta | reservation state |
|---|---|---|---|
| Accept | 0 | +q | RESERVED |
| Start preparing | -q | -q | CONSUMED |
| Cancel pending | 0 | -q | RELEASED |
| Cancel after start | 0 | 0 | CONSUMED; WASTE marker |
| Physical adjustment | signed q | 0 | unchanged |

available = onHand - reserved >= 0. Ledger sums reconcile to current balances from zero opening balances. Opening fixtures write adjustment entries. WASTE is not another withdrawal. Consumption stays recorded even if money is later refunded.

At order acceptance aggregate ingredient requirements, process sorted ingredient IDs, conditionally update balances, create per-unit reservations and ledger within a serializable transaction. Every ingredient succeeds or none commits. Retry transient serialization conflicts; insufficient stock is a business rejection, never a partial acceptance.

No automatic reservation expiry in MVP; manager explicitly cancels abandoned pending orders. Warn about old reservations before pilot. Physical counts below reserved stock are rejected and require manual resolution of pending orders before adjustment; do not silently invent stock or cancel customers.

Recipe snapshot is made at acceptance and is the only consumption source. Recipe edits affect new orders only. Toppings/modifiers, multi-location transfers, yields, costing, batch expiry and multi-stage preparation are future capabilities requiring explicit rules.

Tests: competing last portion, shared multiple ingredients in reverse input order, rollback after later ingredient shortage, retries, START duplicate, pre/post-start partial cancellation, snapshot stability, ledger sums and SQL invariant violation. Integration tests must run against real PostgreSQL.
