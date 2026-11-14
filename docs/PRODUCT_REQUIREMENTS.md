# OMNIHUB product requirements

The complete source specification is preserved verbatim in ORIGINAL_REQUIREMENTS.md. This document refines scope; no long-term requirement is removed. This is a local development project, not a production deployment.

## Scope and gates

MVP vertical slice: one operational store per session, tenant-compatible schema, store memberships, Vietnamese/English POS, products with immutable per-order recipe/price snapshots, atomic reservation, per-unit kitchen work, consume at preparation start, cash settlement, cancellation, stock ledger, basic business-day reporting, audit, command idempotency, outbox and authorized realtime invalidation.

Pilot gate: meaningful PostgreSQL integration/concurrency/security tests, real browser workflows, verified backup restore, operational monitoring, recovery drills, accessible workflows, configured secure transport, deployment runbook. A successful build alone does not pass this gate.

Future commercial scope retains QR/mobile ordering, native website/takeaway channels, variants and modifiers, split/merged bills, partial payments, manual transfer confirmation, refunds, cash shifts/reconciliation, stock receipts/purchasing/locations, waste analysis and valuation, multi-station recipes, scheduled availability, full store/staff administration, Telegram rules/report delivery, charts/exports, offline PWA, authorized external connectors (including GrabFood, ShopeeFood, Messenger), advanced multi-store reporting, platform administration, localization expansion and observability. These are not implied to exist in the first slice.

## Corrected roadmap

0. Domain specifications and architecture.
1. Monorepo, PostgreSQL/Prisma/Redis, auth, scope boundaries, contracts.
2. Catalog, recipes, atomic reservation, POS acceptance.
3. Tickets, preparation/consumption, outbox and realtime.
4. Cancellation, stock adjustment, money, cash settlement, reports.
5. QR ordering, dashboards, Telegram, store administration.
6. Offline PWA, ordered commands and conflict handling.
7. External connectors, commercial multi-store features, advanced analytics.
8. Security/performance/observability, restore drill and pilot readiness.

Each phase requires a runnable state and an honest verification record. Phases 2–4 form one first major milestone; inventory is not bolted onto an earlier POS. Test infrastructure, authorization, idempotency and outbox begin with the first business transaction.

## Explicit MVP policies

- VND only; integer dong, no tax, surcharge, discount or online payment enabled. Reject unsupported financial input rather than ignore it.
- Cash settlement is one full payment after all noncancelled units are handed off. No overpayment balance; change is tender minus amount due.
- Cancellation before preparation releases stock; after preparation begins it never restores stock. Consumed ingredients for a cancelled unit get a WASTE classification without a second stock decrement.
- Sellable products require a nonempty recipe and a single kitchen station. One order item represents one physical unit; quantity input expands into units for unambiguous partial cancellation.
- No order edits after acceptance. Cancel units and create a new order for replacements. Split/merge bills and post-payment cancellation/refunds remain disabled until their own tested commands exist.
- Tenant/store selection is required at login; every request revalidates the current membership. No public self-registration or implicit platform superuser.
- Default business zone Asia/Ho_Chi_Minh, day begins 04:00 local. Reports use a stored business-date key derived at cash confirmation, not client time.

These are implementation decisions for MVP, not assumptions about every restaurant. Changing a policy requires a documented migration/compatibility decision and regression tests.
