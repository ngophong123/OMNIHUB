# Authorization matrix

All permissions are tenant AND store scoped, checked in backend and rechecked within business transactions. No role grants access to another store. A user can hold different roles at different stores. Platform administration and customer access are future, separate auth surfaces.

| Operation | Owner | Manager | Cashier | Kitchen | Inventory |
|---|---|---|---|---|---|
| Read catalog, orders and current kitchen | yes | yes | yes | yes | yes |
| Accept POS order | yes | yes | yes | no | no |
| START / READY kitchen unit | yes | yes | no | yes | no |
| HANDOFF unit | yes | yes | yes | yes | no |
| Cancel pending unit | yes | yes | yes | no | no |
| Cancel started/ready/handed unit | yes | yes | no | no | no |
| Record full cash payment (requires assigned open shift) | yes | yes | yes | no | no |
| Open/close own cash shift; cash-in/out/refund/correction | yes | yes | yes | no | no |
| Create registers; assign a same-store cashier to a shift | yes | yes | no | no | no |
| Approve cash-shift discrepancies | yes | yes | no | no | no |
| Read cash-shift history in current store | yes | yes | yes | no | no |
| Stock balance/ledger read | yes | yes | no | no | yes |
| Adjust stock with reason | yes | yes | no | no | yes |
| Catalog/category/recipe/variant/station administration | yes | yes | no | no | no |
| Ingredient, receipt and stock administration | yes | yes | no | no | yes |
| Financial report | yes | yes | no | no | no |

Cash refunds are compensating movements linked to a payment in the same shift; they do not rewrite a payment. Full-order void/refund workflows, configurable approval thresholds, super-admin access, employee administration and kitchen station-specific assignments need additional policies. Existing slice kitchen role covers all stations within its assigned store. Financial, catalog and inventory writes are re-authorized inside serializable transactions and scoped by the authenticated tenant/store. Session revocation, guessed object IDs, cross-store command replays and WebSocket subscription attempts remain covered by integration tests.
