# Architecture

OMNIHUB is a strict TypeScript monorepo (`pnpm` workspaces) implementing core restaurant operations across POS ordering, inventory reservation, offline-capable kitchen display, QR table ordering, payments, and cashier shift reconciliation.

## Monorepo Layout

- `apps/web`: Next.js `16.4.6` App Router frontend (React 19, TypeScript 5.9, `socket.io-client`), including bilingual (`vi`/`en`) staff workspaces, an offline-capable Kitchen Display System (KDS) PWA using IndexedDB (`omnihub-kitchen-v1`) and `/sw.js`, and mobile QR customer ordering routes.
- `apps/api`: NestJS `12.2` REST API (Express 5), Socket.IO `4.8` gateway, and standalone outbox worker entrypoint (`apps/api/src/worker.ts`).
- `packages/contracts`: Shared Zod `4.6` request, response, and realtime event schemas (`@omnihub/contracts`).
- `prisma`: Single PostgreSQL schema (`36` models, `4` enums, `14` additive migrations including `CHECK` constraints and immutability triggers) and an idempotent local sample data seeder (`prisma/seed.ts`).

## Runtime Topology

```mermaid
flowchart LR
  Clients["Staff Web / KDS PWA / QR Guest"]
  Web["apps/web\nNext.js 16 App Router"]
  API["apps/api\nNestJS REST + Socket.IO"]
  PG[("PostgreSQL 17 (CI / local)\nAuthoritative State + Outbox")]
  Worker["Outbox Worker\napps/api/src/worker.ts"]
  Redis[("Redis 7\nLua Rate Limits + Pub/Sub + Socket.IO Adapter")]

  Clients -->|HTTPS / REST| Web
  Web -->|REST + Cookie / Capability| API
  Clients <-->|Socket.IO| API
  API -->|Serializable / ReadCommitted TX| PG
  API -->|Atomic Lua Rate Limits| Redis
  Worker -->|FOR UPDATE SKIP LOCKED| PG
  Worker -->|Publish omnihub.events| Redis
  Redis -->|Subscribe + Multi-Replica Adapter| API
```

## Backend Structure & Module Organization

`apps/api` is currently organized as a single-controller monolith with domain-separated service classes rather than full NestJS feature modules:

- `apps/api/src/http.ts` exposes all HTTP routes through `ApiController` inside `AppModule`, instantiating shared domain services (`Operations`, `Payments`, `CashShifts`, `Catalog`, `QrOrdering`, `PilotAdmin`) at module scope instead of NestJS dependency-injection feature modules.
- Domain boundaries are separated by file: `domain.ts`, `commands.ts`, `operations.ts`, `catalog.ts`, `catalog-domain.ts`, `payments.ts`, `cash-shifts.ts`, `qr-ordering.ts`, `pilot-admin.ts`, `auth.ts`, `rate-limit.ts`, `outbox.ts`, `realtime.ts`, and `observability/`.
- Refactoring `ApiController` into isolated NestJS feature modules with constructor-injected providers (tracked internally as `M2-T12`) is explicitly pending and documented in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Data Authority & Concurrency Controls

- **PostgreSQL as Single Source of Truth:** All business mutations commit to PostgreSQL via Prisma (`6.19`) — PostgreSQL `17` in CI (`.github/workflows/ci.yml`) and local Docker Compose (`docker-compose.yml`); local staging and backup containers currently use PostgreSQL `18` (`deploy/compose.staging.yml`, `deploy/backup/Dockerfile`). The shared `CommandBus` (`apps/api/src/commands.ts`) executes command transactions at `Serializable` isolation and applies bounded retries for recognized Prisma `P2034`/`P2002` errors and selected transient SQLSTATE `40001`/`40P01` errors (including those wrapped in Prisma `P2010`), up to four total attempts before returning `409`; `externalReference` uniqueness conflicts are handled separately without taking the generic retry path. The separate `runSerializableTransactionWithRetry` helper (`apps/api/src/database.ts`) is used in kitchen-device registration, station assignment, and revocation paths (`apps/api/src/http.ts`) and retries only Prisma `P2034`, for up to three total attempts with bounded jittered backoff.
- **Deterministic Ingredient Locking and Database Invariants:** Order acceptance aggregates ingredient requirements, sorts rows by `ingredientId` ascending, and applies atomic conditional updates (`"onHand" - "reserved" >= quantity`). Database `CHECK` constraints enforce `onHand >= reserved >= 0` and integer VND bounds, while PostgreSQL triggers (`reject_ledger_mutation()`) make `Movement`, `Audit`, and `Payment` rows append-only. Deterministic ingredient ordering applies to inventory reservation locking only; it does not establish system-wide deadlock freedom across other transaction paths.
- **Idempotency:** Mutating endpoints require an `Idempotency-Key` stored in `CommandReceipt` scoped to `(tenantId, storeId, key)` with a SHA-256 request digest. Identical replays return the original result without duplicating side effects; key reuse with a different payload returns `409`.
- **High-Frequency Kitchen Heartbeats:** Registered kitchen device heartbeats (`POST /kitchen/devices/register`) use an atomic conditional `ReadCommitted` `updateMany` (`WHERE revokedAt IS NULL`) so concurrent heartbeats serialize on the row lock via PostgreSQL `EvalPlanQual` without triggering `P2034` bursts, while initial registration, station assignment, and revocation remain `Serializable`.

## Realtime & Transactional Outbox

- Business transactions write `Audit` and `Outbox` rows in the same PostgreSQL commit as domain state changes.
- `apps/api/src/worker.ts` polls ready undelivered outbox rows (`deliveredAt IS NULL AND deadLetteredAt IS NULL AND nextAttemptAt <= now()`) using `FOR UPDATE SKIP LOCKED` inside a bounded batch time budget (`10s` within a `15s` transaction timeout), validates event contracts, and publishes to Redis Pub/Sub (`omnihub.events`) with at-least-once delivery semantics. Transient publish failures increment `attempts` with exponential backoff (`nextAttemptAt`) and transition exhausted or schema-invalid events into a durable Dead Letter Queue (`deadLetteredAt`, `lastError`), which store admins can inspect and replay safely via `GET /admin/outbox/dead-letters` and `POST /admin/outbox/dead-letters/replay`.
- `apps/api/src/realtime.ts` attaches `@socket.io/redis-adapter` for multi-replica fan-out, uses a bounded process-local in-memory FIFO cache of up to `2,048` event IDs (`MAX_SEEN_EVENT_IDS = 2048`) to suppress recently seen duplicate `eventId`s, and broadcasts only to server-selected `(tenantId, storeId)` or order-tracking rooms. The cache is not persistent and is cleared on process restart; outbox delivery remains at-least-once, and clients treat socket events as invalidation triggers and re-fetch authoritative REST state.
- Revocation events (`session.revoked`, `kitchen.device.changed`) trigger immediate best-effort publish plus durable outbox fallback so revoked sessions and kitchen devices are disconnected across replicas.

## Security & Observability Boundaries

- **Authentication & Multi-Tenancy:** Passwords use asynchronous Node `scrypt` (`verifyPasswordAsync`/`hashPasswordAsync`) with per-user salts. Staff sessions use 256-bit opaque tokens stored as SHA-256 hashes in PostgreSQL (`HttpOnly`, `SameSite=Strict`, `Secure` outside local HTTP dev, 8-hour expiry). Staff routes and staff command transactions revalidate active membership, role-scoped read boundaries (`GET /orders` denies `INVENTORY` and strips payment/refund/split fields for `KITCHEN`; `GET /orders/:id/payments` requires `cash` or `report`), and `(tenantId, storeId)` scope, while public QR ordering and guest order-tracking flows use separate capability-token authorization scoped to the resolved table session or order rather than staff sessions. `apps/web` emits `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Permissions-Policy` headers.
- **Rate Limiting & Fail-Closed Ingress:** Public and auth routes use atomic Redis Lua scripts (`EVAL`, `INCR`, `PEXPIRE`, `PTTL` — no `DEL` for Redis 7 ACL compatibility) and fail closed with `503` if Redis is unavailable. `POST /auth/login` combines an IP window limit with a per-account SHA-256 failure lockout (`10` failures / `15` minutes) checked before `scrypt`.
- **Capability Tokens:** QR table credentials, customer table sessions, order tracking tokens, and employee invitations are stored only as SHA-256 digests and masked in logs.
- **Observability:** Single-line structured JSON logs (`application`, `security`, `operational`) propagate validated `X-Correlation-ID` headers across HTTP `AsyncLocalStorage` and outbox batches. Internal Prometheus metrics (`GET /metrics`) expose HTTP golden signals, domain counters, and outbox/realtime telemetry, restricted to Bearer token or unproxied loopback and blocked at the reverse proxy edge.

## Further Reading

- [ORDER-TO-CASH-FLOW.md](ORDER-TO-CASH-FLOW.md) — End-to-end order, kitchen, inventory, payment, and shift lifecycle.
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — Current technical boundaries, out-of-scope features, and pilot NO-GO status.
- Architecture Decision Records: [ADR-0001](adr/0001-serializable-inventory-ledger.md), [ADR-0002](adr/0002-transactional-outbox-and-redis-adapter.md), [ADR-0003](adr/0003-kitchen-device-sync-and-revocation.md).
- Detailed design specs and historical audit notes are preserved under [docs/internal/](internal/).
