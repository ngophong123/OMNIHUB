# OMNIHUB

[![checks](https://github.com/ngophong123/OMNIHUB/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ngophong123/OMNIHUB/actions/workflows/ci.yml)

**Enterprise Restaurant Operations Management Platform** built as a strict TypeScript monorepo with Next.js App Router, NestJS, PostgreSQL/Prisma, and Redis.

> [!IMPORTANT]
> **Status Disclosure:** OMNIHUB is under active engineering development and is **not certified production software**. The latest recorded pilot readiness decision is **NO-GO** for public restaurant rollout pending off-machine disaster recovery provisioning, target site TLS/LAN/hardware verification, and physical operator UAT ([docs/PILOT_READINESS_CHECKLIST.md](docs/PILOT_READINESS_CHECKLIST.md), [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)).

---

## 1. Project Overview

OMNIHUB models core restaurant back-of-house and front-of-house workflows around strong database invariants rather than optimistic CRUD:

- **Catalog & Recipe Authority:** Categories, stations, variants, modifier groups/options, ingredients in exact base units (`Decimal(18,3)`), stock receipts, and versioned `RecipeRevision` histories.
- **Transactional POS & QR Table Ordering:** Immutable per-unit order snapshots, atomic ingredient reservation/consumption, revocable QR table credentials, temporary customer table sessions, and separate per-order tracking capabilities.
- **Offline-First Kitchen Display System (KDS):** Installable PWA caching scoped ticket snapshots and queueing ordered `START`/`READY` transitions in IndexedDB for server-validated reconciliation and conflict review upon reconnect.
- **Payments, Splits, Refunds & Cash Shifts:** Integer VND settlement (`>= 0`, no floating point), bill splitting, partial cash and manually verified bank transfers, reasoned compensating refunds, shift-linked cash drawer reconciliation (`OPEN -> CLOSING -> CLOSED`), and business-day reporting (`Asia/Ho_Chi_Minh`, `04:00` cutoff).

---

## 2. Product Goals and Target Users

### Engineering & Product Goals

1. **Zero Silent Stock or Financial Drift:** Enforce `onHand >= reserved >= 0` and append-only inventory/cash ledgers inside PostgreSQL serializable transactions and database `CHECK`/trigger constraints.
2. **Idempotent, Audit-Ready Operations:** Require `Idempotency-Key` command receipts, immutable audit rows, and transactional outbox events in the same commit as every business mutation.
3. **Graceful Degradation Under Network Disruption:** Keep authenticated KDS transitions operational offline within strict scope (`START`/`READY`), reconcile chronologically without silent last-write-wins, and fail closed on security-sensitive ingress when Redis is unavailable.
4. **Tenant & Store Isolation:** Scope every entity and authorization check by authenticated `(tenantId, storeId)` membership inside both NestJS boundaries and PostgreSQL composite foreign keys.

### Target Personas & Roles

Permissions are enforced server-side and revalidated inside transactions per [docs/AUTHORIZATION_MATRIX.md](docs/AUTHORIZATION_MATRIX.md):

| Role / Surface | Primary Responsibilities |
|---|---|
| **Owner / Manager** | Store catalog/recipe administration, stock receipts, table QR management, device assignment/revocation, employee invitations, bank-transfer verification, refund/shift discrepancy approvals, daily settlement reports. |
| **Cashier** | POS order entry, item handoff, unpaid pending-item/order cancellation, cash shift opening/closing/movements, partial cash collection, bill splits, refund requests. |
| **Kitchen** | Station ticket preparation (`START` -> `READY`) online or offline via registered kitchen devices, item handoff, manual conflict queue review. |
| **Inventory** | Ingredient balances, stock receipts, reasoned stock adjustments (never below `reserved`), immutable ledger inspection. |
| **Dine-in Guest (QR)** | Unauthenticated table menu browsing via rotated QR capability, 4-hour table session ordering, single-order live status tracking (`ACCEPTED` -> `SERVED`). |

---

## 3. Key Features

Status tags below distinguish verified code from environment-gated or future capabilities:

| Capability | Status | Scope & Notes |
|---|---|---|
| POS ordering, unit expansion & recipe snapshots | **Implemented** | Server-computed VND prices, variants/modifiers, and composed recipes ([docs/ORDER_LIFECYCLE.md](docs/ORDER_LIFECYCLE.md)). |
| Atomic inventory reservation, consumption & ledger | **Implemented** | `RESERVED` -> `CONSUMED` on `START`, `RELEASED` on pre-start cancel, `WASTE` marker post-start ([docs/INVENTORY_LIFECYCLE.md](docs/INVENTORY_LIFECYCLE.md)). |
| Catalog, recipes, variants, modifiers & stock receipts | **Implemented** | Owner/manager CRUD with optimistic `expectedVersion` concurrency and paginated ledger filters. |
| Kitchen workflow & Socket.IO realtime invalidation | **Implemented** | Worker polls transactional `Outbox` and publishes to Redis Pub/Sub; clients refetch REST state ([docs/REALTIME_ARCHITECTURE.md](docs/REALTIME_ARCHITECTURE.md)). |
| Offline-first Kitchen PWA (`START` / `READY`) | **Implemented** | Service Worker shell cache + IndexedDB (`omnihub-kitchen-v1`) ordered queue and conflict review ([docs/OFFLINE_SYNC.md](docs/OFFLINE_SYNC.md)). |
| Split bills, cash/transfer payments, refunds & cash shifts | **Implemented** | Partial payments, manual bank-transfer verification, compensating refunds, register shift reconciliation ([docs/PAYMENT_RULES.md](docs/PAYMENT_RULES.md), [docs/CASH_SHIFT_LIFECYCLE.md](docs/CASH_SHIFT_LIFECYCLE.md)). |
| QR table ordering & private guest tracking | **Implemented** | 256-bit random capabilities stored as SHA-256 hashes; rotatable QR generations ([docs/QR_ORDERING_LIFECYCLE.md](docs/QR_ORDERING_LIFECYCLE.md), [docs/QR_ORDERING_SECURITY.md](docs/QR_ORDERING_SECURITY.md)). |
| Employee invitations, device binding & revocation | **Implemented** | Single-use 24h store invites, kitchen device station assignment, audit history, socket disconnect on revoke. |
| Bilingual UI (`vi` / `en`) & responsive views | **Implemented** | Vietnamese default with English toggle across POS, KDS, admin, cash, and QR mobile order routes. |
| Local staging TLS/proxy & encrypted Restic backup tooling | **Implemented (Local Staging Only)** | Caddy internal CA, Docker `/run/secrets`, `omnihub_app`/`omnihub_owner`/`omnihub_backup` PostgreSQL roles, encrypted Restic drills ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md)). |
| Off-machine DR, automated paging & live restaurant rollout | **Blocked (Pilot NO-GO)** | Tooling prepared (`offsite.sh`, `monitor.sh`), but no approved off-site backup repository, alert endpoint, public PKI, or physical site UAT exists. |
| Card acquiring & signed provider webhooks | **Disabled (`SANDBOX_ONLY`)** | `LabeledCardSandboxAdapter` always rejects card authorization; webhook endpoints and signature verification are not implemented ([docs/PAYMENT_RULES.md](docs/PAYMENT_RULES.md)). |
| Multi-branch runtime switching & multi-warehouse transfers | **Planned** | Schema is tenant/store-scoped, but current auth sessions bind to one selected `storeId`; no runtime store switcher or inter-warehouse stock transfer exists yet. |
| Tax/discounts, delivery channels (GrabFood/ShopeeFood), Telegram | **Planned** | Retained in [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) and [docs/ORIGINAL_REQUIREMENTS.md](docs/ORIGINAL_REQUIREMENTS.md); not implemented. |

---

## 4. System Architecture

OMNIHUB uses a **modular monolith backend** paired with a **standalone outbox worker** sharing one Prisma schema and Zod contract package:

```text
+-----------------------------------------------------------------------+
|                         Clients (Exact WEB_ORIGIN)                    |
|   Staff POS / Admin / Cash / KDS PWA (IndexedDB + /sw.js)             |
|   Customer Mobile QR Menu & Private Order Tracking                    |
+---------------------------+--------------------------+----------------+
                            | HTTPS / REST             | WebSocket (Socket.IO)
                            v                          v
+-----------------------------------------------------------------------+
|                apps/web (Next.js 16 App Router)                       |
+-----------------------------------------------------------------------+
                            |
                            v
+-----------------------------------------------------------------------+
|          apps/api (NestJS REST + Socket.IO Gateway)                   |
|  - HttpOnly session cookie auth + role/store revalidation             |
|  - Fail-closed Redis Lua rate limiter (/auth, /public/*)              |
|  - Serializable Prisma transaction command bus                        |
+-----------------+------------------------------------+----------------+
                  |                                    ^
      Read/Write  |                                    | Pub/Sub:
   (Serializable  |                                    | omnihub.events
     tx + Outbox) |                                    |
                  v                                    |
+-----------------------------------+   poll   +-------+----------------+
|  PostgreSQL 17/18 (Authoritative) |<---------+ apps/api/src/worker.ts |
|  36 Prisma models, 13 migrations  |  Outbox  | Redis 7 Pub/Sub client |
|  Audit, CommandReceipt, Constraints|         +------------------------+
+-----------------------------------+
```

Detailed architectural references:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Modular monolith boundaries, serializable transactions, and outbox semantics.
- [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) — Entities, unit conversion, recipe versioning, and ledger invariants.
- [docs/REALTIME_ARCHITECTURE.md](docs/REALTIME_ARCHITECTURE.md) — Redis Pub/Sub invalidation, Socket.IO room authorization, and polling fallback.
- [docs/OFFLINE_SYNC.md](docs/OFFLINE_SYNC.md) — KDS PWA storage scope, sequence replay, and conflict resolution.
- [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) — Implemented HTTP endpoints, error codes, and Socket.IO events.

---

## 5. Technology Stack

| Layer | Technology & Version | Source |
|---|---|---|
| **Runtime & Package Manager** | Node.js `>=22.14.0`, pnpm `12.4.1` (workspace monorepo) | [package.json](package.json), [pnpm-workspace.yaml](pnpm-workspace.yaml) |
| **Language & Shared Contracts** | TypeScript `^5.9.0` (`strict`, `noUncheckedIndexedAccess`), Zod `^3.25.0` | [tsconfig.base.json](tsconfig.base.json), [packages/contracts/package.json](packages/contracts/package.json) |
| **Frontend** | Next.js `16.4.2` (App Router, webpack build), React `^19.2.0`, `socket.io-client ^4.8.1` | [apps/web/package.json](apps/web/package.json) |
| **Backend & Worker** | NestJS `12.2.0`, Express `^5.1.0`, Helmet `^8.1.0`, `express-rate-limit ^8.1.0`, `socket.io ^4.8.1`, `qrcode 1.5.4` | [apps/api/package.json](apps/api/package.json) |
| **Database & ORM** | PostgreSQL `17-alpine` (Compose/CI) / optional `18`, Prisma `6.19.0`, `embedded-postgres 18.4.0-beta.17` | [docker-compose.yml](docker-compose.yml), [prisma/schema.prisma](prisma/schema.prisma) |
| **Cache & Realtime Broker** | Redis `7-alpine`, `ioredis ^5.8.0` | [docker-compose.yml](docker-compose.yml), [apps/api/package.json](apps/api/package.json) |
| **Testing & Quality** | Vitest `^4.1.12`, Playwright `^1.56.0`, ESLint `^10.13.0` (`typescript-eslint ^8.72.0`) | [package.json](package.json), [eslint.config.mjs](eslint.config.mjs), [playwright.config.ts](playwright.config.ts) |
| **Staging & Backup Tooling** | Docker Compose, Caddy (local internal CA), Restic (`postgres:18-alpine`) | [deploy/compose.staging.yml](deploy/compose.staging.yml), [deploy/backup/Dockerfile](deploy/backup/Dockerfile) |

---

## 6. Repository Structure

```text
OMNIHUB/
├── .github/
│   ├── ISSUE_TEMPLATE/          # Bug report and feature request YAML forms
│   ├── workflows/ci.yml         # Hosted CI (Postgres 17 + Redis 7 services)
│   └── pull_request_template.md
├── apps/
│   ├── api/                     # NestJS REST API, Socket.IO gateway, outbox worker
│   └── web/                     # Next.js 16 App Router UI, KDS PWA & QR guest pages
├── packages/
│   └── contracts/               # Shared Zod schemas and TypeScript contracts
├── prisma/
│   ├── migrations/              # 13 additive PostgreSQL migrations
│   ├── schema.prisma            # 36 models, 4 enums, composite tenant/store FKs
│   └── seed.ts                  # Idempotent local demo fixture seeder
├── deploy/
│   ├── backup/                  # Restic backup, offsite copy, DR monitor & alert scripts
│   ├── Caddyfile                # Local staging TLS proxy config
│   ├── compose.staging.yml      # Hardened local staging Compose definition
│   └── Dockerfile               # Multi-stage API & web container builds
├── scripts/                     # Local embedded Postgres, staging secret/TLS/backup drills
├── tests/
│   ├── unit/                    # Pure domain, rate-limit & deployment-security tests (27)
│   ├── integration/             # Real PostgreSQL transactional & isolation tests (27)
│   ├── redis/                   # Redis Lua & multi-process API rate-limit tests (2)
│   ├── e2e/                     # Playwright browser workflow tests (9)
│   └── backup/                  # Disposable fake/stale archive test fixtures
├── docs/                        # 22 architecture, lifecycle, security, testing & status docs
├── CONTRIBUTING.md
└── README.md
```

---

## 7. Core Engineering Decisions

- **Serializable Transactions & Deadlock-Safe Locking:** Business commands in [apps/api/src/operations.ts](apps/api/src/operations.ts) run inside PostgreSQL `Serializable` Prisma transactions with bounded `P2034` conflict retries (up to 4 retries, returning HTTP `409` on exhaustion) and deterministic sorted ingredient ID locking to prevent stock races and deadlocks.
- **Exact Numeric & Financial Semantics:** Ingredient balances use `Decimal(18,3)` with exact decimal string normalization (`kg -> g`, `l -> ml`; rejecting implicit cross-dimension density conversions), while monetary totals use integer VND with deterministic largest-remainder allocation (`allocateVnd`) in [apps/api/src/domain.ts](apps/api/src/domain.ts).
- **Command Idempotency & Transactional Outbox:** Mutating endpoints require `Idempotency-Key` tracked in `CommandReceipt` keyed by `(tenantId, storeId, key)` with an actor/operation/payload SHA-256 hash—replaying identical requests without duplicating side effects and rejecting key reuse with modified payloads (`409`). `Audit` and `Outbox` rows commit in the same transaction.
- **Authoritative State Over Event-Only Trust:** Redis Pub/Sub (`omnihub.events`) acts solely as a transient invalidation trigger. Clients re-fetch REST projections on events, reconnects, and periodic intervals so Redis interruptions never undo committed PostgreSQL writes.
- **Scoped Offline KDS With Explicit Conflict Review:** IndexedDB (`omnihub-kitchen-v1`) stores minimal ticket metadata (zero session cookies, prices, or payment details) and queues ordered `START`/`READY` commands per `(tenantId, storeId, userId)`. Replay stops on version mismatches, returning `CONFLICT` and holding subsequent order commands as `BLOCKED` for human review rather than silently overwriting server state ([docs/OFFLINE_SYNC.md](docs/OFFLINE_SYNC.md)).
- **Capability Hashes & Fail-Closed Boundaries:** QR tokens, table sessions, order tracking tokens, invitations, and staff session tokens are stored exclusively as SHA-256 hashes. Protected `/auth` and `/public/*` ingress routes fail closed (`503`) on Redis loss, and production boot rejects insecure configuration in [apps/api/src/deployment-security.ts](apps/api/src/deployment-security.ts).

---

## 8. Local Development Setup

### Prerequisites

- **Node.js `>=22.14.0`** and **pnpm `12.4.1`**
- **Docker** (for local PostgreSQL 17 and Redis 7 via [docker-compose.yml](docker-compose.yml))
- *Windows PowerShell note:* Use `pnpm.cmd` if execution policy blocks `pnpm.ps1`.

### Run Locally

```sh
pnpm install

# 1. Create untracked local configuration from template
cp .env.example .env
# Edit .env: set SEED_DEMO=true and a unique DEMO_PASSWORD (>= 12 chars) for local demo fixtures.

# 2. Start PostgreSQL 17 and Redis 7 (loopback only)
pnpm infra:up

# 3. Generate Prisma client, apply migrations, seed fixtures, build shared contracts
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm --filter @omnihub/contracts build

# 4. Run API + Next.js web dev servers
pnpm dev

# 5. In a second terminal, run the outbox realtime worker
pnpm worker
```

- **Web UI:** `http://localhost:3000` | **API health:** `http://localhost:4000/health` (browser origin must match `WEB_ORIGIN` in `.env`; `localhost` and `127.0.0.1` are treated as distinct origins).
- **Optional PostgreSQL without Docker:** Run `pnpm db:local` ([scripts/local-postgres.ts](scripts/local-postgres.ts)) to launch embedded PostgreSQL on `127.0.0.1:5432` with data stored under ignored `.local/postgres/`. Do not run alongside Compose PostgreSQL on the same port. Note that Redis is still required for realtime push, new sign-ins, and shared rate limiting.
- **Seeded Local Accounts (`prisma/seed.ts`):** Store ID `22222222-2222-4222-8222-222222222222`; accounts `owner@local.omnihub.test`, `cashier@local.omnihub.test`, `kitchen@local.omnihub.test`, `inventory@local.omnihub.test` using `DEMO_PASSWORD` from `.env`. Seed runs additively once and never overwrites existing data.

---

## 9. Environment Configuration

All baseline variables are templated in [.env.example](.env.example). Never commit `.env` or secret files.

| Variable | Purpose | Local Default / Rule |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection URI | Local loopback fixture URI in `.env.example`; production requires TLS (`sslmode=verify-full`) unless `DATA_NETWORK_MODE=isolated-single-host`. |
| `REDIS_URL` | Redis connection URI | `redis://localhost:6379` locally; production requires authenticated `redis://` / `rediss://` ACL user. |
| `WEB_ORIGIN` | Allowed browser origin for CORS & CSRF checks | `http://localhost:3000` locally; exact `https://` origin required in production (no wildcards or path). |
| `NEXT_PUBLIC_API_URL` | Public API URL used by browser client | `http://localhost:4000` locally; set to proxied HTTPS API origin for staging/deployment. |
| `PORT` / `API_HOST` | API listen port and bind address | `4000` / `127.0.0.1` locally (`0.0.0.0` inside container behind reverse proxy). |
| `SESSION_SECURE` | Sets `Secure` flag on `HttpOnly` session cookie | `false` only for local HTTP dev; **must be `true` in production**. |
| `QR_TOKEN_SECRET` | HMAC/derivation secret for deterministic tracking token recovery | At least 32 random characters required in production (API fails closed if absent). |
| `TRUSTED_PROXY_CIDRS` | Explicit reverse-proxy IPs/CIDRs for client IP resolution | Empty locally; explicit peer IP/CIDR in production (rejects `0.0.0.0/0`, `::/0`, `true`). |
| `AUTH_LOGIN_RATE_LIMIT`, `PUBLIC_API_RATE_LIMIT`, `QR_ORDER_RATE_LIMIT`, `WEBHOOK_RATE_LIMIT`, `RATE_LIMIT_WINDOW_SECONDS` | Redis Lua sliding/fixed window request caps | Defaults: `10`, `60`, `20`, `120` per `60s` window. |
| `SEED_DEMO` / `DEMO_PASSWORD` | Controls local development seeding | Keep `SEED_DEMO=false` outside local/staging acceptance; `DEMO_PASSWORD` >= 12 chars when seeding. |

---

## 10. Testing Strategy

OMNIHUB separates fast deterministic checks from database, Redis, browser, and DR drills ([docs/TESTING.md](docs/TESTING.md)):

| Suite | Command | Cases | Dependencies & Scope |
|---|---|---|---|
| **Static Checks** | `pnpm typecheck`, `pnpm lint`, `pnpm build` | — | Strict TypeScript across packages, ESLint (no explicit `any`), production compilation. |
| **Unit Tests** | `pnpm test` | 27 tests (3 files) | Pure domain math/permissions, deployment security validator, mock rate-limit atomicity ([tests/unit/](tests/unit/domain.test.ts)). |
| **PostgreSQL Integration** | `pnpm test:integration` | 27 tests (1 file) | Real migrated Postgres database: stock races, rollback, idempotency, splits, refunds, cash shifts, tenant isolation ([tests/integration/operations.test.ts](tests/integration/operations.test.ts)). |
| **Redis Integration** | `pnpm test:redis` | 2 tests (2 files) | Real Redis (`REDIS_URL`) + two spawned built API processes verifying atomic Lua limits across replicas ([tests/redis/](tests/redis/api-replicas.test.ts)). |
| **Playwright E2E** | `pnpm test:e2e` | 9 workflows (1 file) | Built `web` + `api` + `worker` + Postgres + Redis + Chromium: POS, cash shifts, two-browser Socket.IO reconnect, offline KDS conflict, QR mobile order, device revocation ([tests/e2e/workflow.spec.ts](tests/e2e/workflow.spec.ts)). |
| **Backup & DR Probes** | `scripts/verify-*.ts`, `deploy/backup/test-*.sh` | Manual / Staging | Custom `pg_dump` + SHA-256 + Restic decryption, schema/migration/integrity checks on isolated restore DBs ([docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md)). |

> [!NOTE]
> **CI Coverage Disclosure:** The current GitHub Actions workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml)) executes `db:generate`, `db:migrate`, `contracts build`, `typecheck`, `lint`, unit `test`, PostgreSQL `test:integration`, and `build` against Postgres 17. It **does not yet execute `pnpm test:redis` (Redis integration tests), `pnpm test:e2e` (Playwright browser tests), or backup/security scans**.

---

## 11. Current Implementation Status

### Latest Verified Automated Execution (`8913a09`, 2026-11-14)

- **GitHub Actions CI (`checks` Run `#43535373056` on `main`):** **PASSED** (`pnpm install --frozen-lockfile`, `db:generate`, `db:migrate`, `contracts build`, `typecheck`, `lint`, unit `test`, `test:integration`, `build`).
- **Local Baseline Verification (`8913a09`):** `pnpm.cmd typecheck`, `pnpm.cmd lint`, `pnpm.cmd test` (`27/27` unit tests), `@omnihub/contracts build`, and `@omnihub/api build` passed. Local `@omnihub/web build` exited `1` due to a Windows file ACL `EPERM` when unlinking a pre-existing untracked `apps/web/.next/server/app/index.html` cache artifact (Linux CI `pnpm build` passed).

### Historical Local & Staging Verification (`2026-10-23` to `2026-10-26`)

Not rerun in the current baseline/documentation milestone; retained as historical evidence in [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) and [docs/TESTING.md](docs/TESTING.md):
- Isolated local HTTPS Docker staging: `9/9` Playwright E2E workflows passed twice on `2026-10-23` and `2026-10-24` after POS fix; `2/2` Redis tests passed in staging network.
- Isolated backup & DR tooling drills (`2026-10-24` to `2026-10-26`): verified encrypted Restic snapshots restored into retained isolated databases (`37` PostgreSQL tables, `13` migrations, zero integrity violations) and passed disposable container DR monitor/offsite negative probes.

### Pilot Decision: **NO-GO**

Public restaurant deployment remains **NO-GO** per [docs/PILOT_READINESS_CHECKLIST.md](docs/PILOT_READINESS_CHECKLIST.md):
- Host outage drills exposed recovery-point ages of `35,797 s` (`2026-10-24`) and `212,374 s` (`2026-10-26`), violating the 900-second (15-minute) RPO gate.
- Off-machine encrypted backup storage, independent monitoring host, alert recipient endpoint, operator DNS/public PKI, and physical hardware/staff UAT ([docs/PILOT_UAT.md](docs/PILOT_UAT.md)) remain unprovisioned/unverified.

---

## 12. Roadmap

Planned evolution tracked in [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) and [docs/PILOT_READINESS_CHECKLIST.md](docs/PILOT_READINESS_CHECKLIST.md):

1. **Multi-Branch & Multi-Warehouse Operations (Next Engineering Sprint):** Runtime store/branch switching within a tenant, multi-warehouse inventory balances, inter-warehouse stock transfers, and cross-branch reporting.
2. **CI Pipeline Expansion:** Wire `pnpm test:redis`, `pnpm test:e2e`, dependency/secret scanning, and backup shell fixture validation into `.github/workflows/ci.yml`.
3. **Payment Provider & Webhook Integration:** Replace `LabeledCardSandboxAdapter` with an authorized payment provider adapter, signed webhook verification, replay protection, and automated non-cash refund reconciliation.
4. **Commercial Operations & Integrations:** Tax/discount/service-fee rules with order-level allocation snapshots, per-station kitchen ACLs, Telegram/external delivery channel connectors (e.g., GrabFood, ShopeeFood), and metrics/alerting.
5. **Pilot Operational Readiness:** Off-machine Restic repository + independent external DR monitor, sustained 15-minute RPO proof, target LAN/TLS/printer setup, and physical UAT sign-off.

---

## 13. Security Considerations

Detailed controls and operator responsibilities are documented in [docs/SECURITY.md](docs/SECURITY.md) and [docs/QR_ORDERING_SECURITY.md](docs/QR_ORDERING_SECURITY.md):

- **Authentication & Sessions:** Node `scrypt` per-user salted password hashing; 256-bit opaque session tokens hashed in PostgreSQL (8h expiry, `HttpOnly`, `SameSite=Strict`, `Secure` when `SESSION_SECURE=true`); active user/membership revalidated on requests and periodic WebSocket checks.
- **Origin, Headers & Rate Limiting:** Exact `WEB_ORIGIN` validation on mutating requests (no wildcard credentialed CORS), Helmet headers, configurable `TRUSTED_PROXY_CIDRS`, and shared Redis Lua rate counters that fail closed (`503`) on Redis unavailability.
- **Capability Redaction & Data Minimization:** QR, table session, tracking, and invitation tokens are stored as SHA-256 digests; structured API access logs redact capability path parameters and drop query strings; KDS IndexedDB never stores session cookies or financial records.
- **Remaining Security Boundaries:** Unsalted SHA-256 client-IP rate-limit digests prevent cleartext IP keys in Redis without formal anonymization guarantees; webhook endpoints and live card acquiring remain unimplemented; npm advisory audits, host/network firewalls, and penetration testing are required before production exposure.

---

## 14. Known Limitations

- **No Live Card Acquiring or Payment Webhooks:** Card checkout is intentionally blocked (`LabeledCardSandboxAdapter`, `SANDBOX_ONLY`).
- **Financial Scope Limits:** Integer VND only; no tax, discount, or service-charge calculation model; no whole-order cancellation workflow after payment; manual non-cash refund disbursement outside the app.
- **Single-Store Session Context:** Authenticated staff sessions scope to one store selected at login; multi-branch store switching and inter-warehouse transfers are not implemented.
- **Kitchen Offline & Station Scope:** Offline PWA supports only cached tickets and `START`/`READY` transitions (online required for order entry, handoff, cancel, payments, inventory); `KITCHEN` role applies across all stations in a store (no per-station ACL yet).
- **Backup RPO & Pilot Gates:** Logical `pg_dump` every 300s (no PostgreSQL WAL archiving / PITR yet); local staging only; **Pilot status is NO-GO**.

---

## Contributing & License

- **Contributing:** See [CONTRIBUTING.md](CONTRIBUTING.md) for branch conventions, Conventional Commits, testing gates, security reporting, and AI-assisted engineering transparency rules.
- **License:** No open-source `LICENSE` file has been selected yet (`All Rights Reserved` by default pending licensing evaluation).
