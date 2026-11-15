# Implemented API

Base http://localhost:4000. Cookie auth; all POSTs require exact WEB_ORIGIN. Business POSTs require Idempotency-Key (UUID v4), except `/kitchen/sync`, whose UUIDv4 `commandId` is the idempotency key. Preserve command IDs across transport/server retries. JSON errors contain code and correlationId.

| Method | Path | Body / result |
|---|---|---|
| GET | /health, /ready | Liveness / readiness checks PostgreSQL and Redis PING |
| POST | /auth/login | {email,password,storeId} -> HttpOnly session |
| GET | /auth/me | Current user, role and store |
| POST | /auth/logout | Revokes current session |
| GET | /public/qr/:token/menu | Public table/store identity, active categorized menu, HTTPS images, server-derived stock availability, variants and modifier pricing; no employee/store IDs exposed |
| POST | /public/qr/:token/session | Opens a separate four-hour table session and returns its one-time bearer token |
| GET | /public/table-sessions/me | Authorization: Bearer session token; validates and returns only current restaurant/table/session expiry |
| POST | /public/table-sessions/orders | Authorization: Bearer session token; UUID v4 Idempotency-Key; standard `{lines:[{productId,quantity,variantId?,modifierIds?,note?}]}`; server-priced QR order returns an order-specific tracking token |
| GET | /public/order-status/:trackingToken | Order-only safe status view; no authentication cookie required |
| GET | /catalog | Active products and server prices |
| GET | /orders | Latest 100 scoped orders/items/tickets/payment summary |
| POST | /orders | {lines:[{productId,quantity,variantId?,modifierIds?}]} -> {id,version}; server calculates price and recipe |
| POST | /items/:id/commands | {expectedVersion,action:START/READY/HANDOFF/CANCEL} |
| POST | /kitchen/devices/register | {deviceId}; binds a non-secret UUID to the authenticated kitchen user/store; revoked or cross-scope IDs are rejected |
| POST | /kitchen/sync | {commands:[{commandId,tenantId,storeId,deviceId,sequence,orderId,itemId,expectedVersion,action,createdAt}]}; max 50 ordered START/READY operations; revalidates session, membership and device, then returns per-command CONFIRMED/CONFLICT/REJECTED/BLOCKED results |
| POST | /admin/kitchen/devices/:id/revoke | Owner/manager revokes a device in the authenticated store |
| GET | /admin/kitchen/devices | Owner/manager lists store-scoped device, station, recent activity and employee session-expiry summaries |
| PUT | /admin/kitchen/devices/:id/assignment | {stationId|null}; assigns device access to a same-store active station, audited transactionally |
| GET | /admin/kitchen/devices/:id/activity | Store-scoped device audit history |
| GET/POST | /admin/invitations | Owner/manager lists invitations or creates a single-use 24-hour employee invite; raw token returned only once |
| POST | /admin/invitations/:id/revoke | Revokes a pending invitation in the authenticated store |
| POST | /public/invitations/:token/accept | {password}; accepts valid invite; existing accounts must prove their password |
| GET | /admin/pilot-readiness | Store-scoped counts/configuration for the bilingual onboarding checklist |
| GET | /orders/:id/payments | Store-scoped payment, refund and split history with settled/refunded totals and remaining balance |
| POST | /orders/:id/payments | {amount,method,tendered?,externalReference?,splitId?}; supports cash and pending manual bank transfers; card is disabled |
| POST | /orders/:id/cancel | {expectedVersion,reason}; cancels an unpaid order atomically, releasing reserved stock and recording consumed ingredients as waste |
| POST | /orders/:id/splits | {label,amount? or itemIds}; append-only payer portion, without new tickets or reservations |
| POST | /payments/:id/verify | Owner/manager manually verifies one pending bank transfer |
| POST | /payments/:id/fail | {reason}; owner/manager records a failed transfer attempt and releases its reserved balance |
| POST | /payments/:id/refunds | {amount,reason,itemId?}; creates a reasoned refund request against a settled original payment |
| POST | /refunds/:id/decision | {decision,reason}; owner/manager approval or rejection; cash approval records shift movement |
| POST | /orders/:id/cash | Legacy full-balance cash endpoint retained; new UI uses /orders/:id/payments |
| GET | /cash/registers | Active registers in the authenticated store |
| GET | /cash/assignments | Active cashier/owner/manager memberships in the authenticated store |
| POST | /cash/registers | {name}; owner/manager only; audited register creation |
| GET | /cash/shifts | Latest 100 store shifts with register, cashier, payments and cash movements |
| POST | /cash/shifts | {registerId,cashierId?,openingAmount}; cashier opens self, owner/manager may assign a store member |
| POST | /cash/shifts/:id/close | {expectedVersion,countedAmount,reason?}; variance requires reason and manager approval |
| POST | /cash/shifts/:id/approve | {expectedVersion,reason}; owner/manager approval of a pending discrepancy |
| POST | /cash/movements | {shiftId,kind,amount,reason,paymentId?}; kinds CASH_IN/CASH_OUT/REFUND/CORRECTION_IN/CORRECTION_OUT |
| GET | /inventory | Ingredient balances, inventory permission |
| GET | /inventory/movements | Latest 200 movements, inventory permission |
| POST | /inventory/adjustments | {ingredientId,delta:string,reason} |
| GET | /reports/daily | Latest 31 recorded payment business days, report permission |
| GET | /admin/products | Search/filter/page with q, page, pageSize, status, categoryId, stationId and manualAvailable |
| POST/PUT/DELETE | /admin/products[/:id] | Versioned product CRUD; body carries name, description, integer VND price, active/manualAvailable, stationId, categoryId and non-empty recipe lines {ingredientId,quantity,unit}; updates also carry expectedVersion |
| GET/PUT | /admin/tables/config | Read/set store QR-ordering availability; manager/owner only |
| GET/POST/PUT | /admin/tables[/:id] | List/create/rename/enable/deactivate store-scoped tables; create returns the one-time QR bearer; update carries expectedVersion |
| POST | /admin/tables/:id/regenerate-qr | Rotates the QR credential; returns the new one-time bearer and invalidates prior QR sessions |
| GET | /admin/tables/qr-code | Authenticated store-scoped SVG QR (`X-QR-Token` header or legacy `?token=` fallback); enforces 64-hex token format, `404 TABLE_NOT_FOUND` on out-of-scope tokens, and `no-store`/`no-referrer`/`nosniff` response headers |
| POST | /admin/tables/sessions/:id/close | Manager closes an active customer session |
| POST | /admin/products/:id/availability | {expectedVersion,available} manual sale control |
| GET/POST/PUT | /admin/categories[/:id] | Paginated q/status listing; create {name}; update {name,active,expectedVersion}; DELETE archives with expectedVersion |
| GET/POST/PUT/DELETE | /admin/stations[/:id] | Station CRUD and product routing; update/archive uses expectedVersion |
| GET/POST/PUT/DELETE | /admin/ingredients[/:id] | Ingredient CRUD with unit and lowStockThreshold; changes use expectedVersion |
| GET/POST/PUT | /admin/products/:id/variants and /admin/products/:productId/variants/:id | Variant absolute price, recipe multiplier, active status and expectedVersion on update |
| GET/POST/PUT | /admin/products/:id/modifier-groups and /admin/products/:productId/modifier-groups/:id | Modifier group min/max selections and active status |
| POST/PUT | /admin/modifier-groups/:id/options and /admin/modifier-groups/:groupId/options/:id | Topping/modifier price delta and ingredient recipe lines |
| POST | /admin/inventory/receipts | {reference,supplier,lines:[{ingredientId,quantity,unit}]}; adds stock and immutable receipt movements atomically |
| GET | /admin/inventory/movements | Paginated ledger with ingredientId, kind, from and to filters |

Version refers to parent order, including item commands. Replay returns original response/version; GET current state before subsequent commands. Global error classification ([errors.ts](../apps/api/src/errors.ts)) maps HTTP/Prisma/parser failures into `{ code, correlationId }` without leaking SQL/stack details: `400` invalid input/references/JSON, `401` unauthenticated, `403` permission/origin, `404` scoped missing (`ROUTE_NOT_FOUND`, `RESOURCE_NOT_FOUND`), `409` unique/serialization/stock/transition/version/key conflict, `429` rate limit, `500` redacted unexpected errors, and `503` DB/Redis unavailability. Authentication, public QR/order, and webhook path prefixes have independently configured Redis-backed limits; webhook APIs themselves are not implemented.

Socket.io accepts employee cookie or a per-order tracking capability and exact Origin. Kitchen sockets also require the matching non-secret device ID; revoked and station-reassigned devices are disconnected. The server selects the employee store room or customer order-only room; clients cannot choose rooms. Employee `operational.event` messages remain store scoped. Customer sockets receive only `customer.order.updated` notifications and must reload the order-only REST projection. Catalog, recipe, ingredient, station, receipt, cash, payment, table and order mutations write audit/outbox records in the same transaction; clients invalidate and REST-resync, and delivery may duplicate/reorder. Redis Pub/Sub delivery remains unverified in environments where Redis cannot start; readiness checks Redis PING for protected shared rate limiting, not worker/socket delivery. See [QR lifecycle](QR_ORDERING_LIFECYCLE.md) and [QR security](QR_ORDERING_SECURITY.md).
