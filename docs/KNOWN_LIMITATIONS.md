# Known Limitations

OMNIHUB is a portfolio project built to demonstrate transactional backend design, realtime coordination, and full-stack restaurant workflows using sample data only. It is **not production-ready** and its latest internal pilot readiness assessment is **NO-GO**.

## Operational & Pilot Readiness Gaps

- **No Live Restaurant Deployment:** The application has only been verified in local development, isolated local Docker staging, and GitHub Actions CI. No physical restaurant hardware, LAN/printer setup, public DNS/TLS cutover, or staff UAT has been executed.
- **No Off-Machine Backup or PITR:** Local staging scripts provide logical `pg_dump` snapshots encrypted with Restic, but no off-machine backup repository, independent monitoring host, alert webhook/paging endpoint, or PostgreSQL WAL archiving / point-in-time recovery (PITR) is provisioned. No RPO/RTO SLA is claimed.
- **No Live Payment Acquiring or Webhooks:** `CARD` checkout is routed to `LabeledCardSandboxAdapter` (`SANDBOX_ONLY`), which always rejects authorization. Bank transfers require manual manager verification (`POST /payments/:id/verify`). No payment provider SDK, signed webhook endpoint, or automated payout reconciliation exists.

## Architectural & Codebase Limitations

- **Single-Controller NestJS Wiring (`M2-T12` Pending):** Although domain logic is split across service classes (`operations.ts`, `payments.ts`, `cash-shifts.ts`, `catalog.ts`, `qr-ordering.ts`, `pilot-admin.ts`), `apps/api/src/http.ts` still wires all routes through one `ApiController` with module-level service instances rather than full NestJS DI feature modules.
- **Single-Store Session Context:** Database entities and composite foreign keys are scoped to `(tenantId, storeId)`, but staff login binds a session to one `storeId` at a time. Runtime store switching and cross-branch consolidated reporting are not implemented.
- **Offline KDS Scope:** The KDS PWA (`omnihub-kitchen-v1` IndexedDB + `/sw.js`) supports only cached ticket viewing and queued `START`/`READY` transitions while offline. Order entry, item handoff, cancellations, payments, and inventory updates require connectivity.
- **Kitchen Station ACL Scope:** Station assignment restricts ticket visibility and command execution per registered `KitchenDevice`, but the `KITCHEN` role itself is store-wide rather than backed by per-station user ACL tables.
- **No Post-Payment Whole-Order Cancellation:** Once an order has active or settled payments, item/order cancellation is blocked; financial corrections must go through the compensating refund workflow.

## Explicitly Out of Scope

The following items are intentionally not implemented in this portfolio repository:

- Multi-branch runtime switching and multi-warehouse stock transfers.
- Tax, discount, promotion, and service-charge calculation models.
- External delivery platform integrations (GrabFood, ShopeeFood) and Telegram bot notifications.
- Public domain provisioning, production secret management, and multi-region failover.
- `M2-T15` / production rollout automation and external penetration testing.
