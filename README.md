# OMNIHUB

Restaurant operations monorepo with Next.js, NestJS, PostgreSQL/Prisma and Redis realtime. Vietnamese by default, English available.

Current operational slices include owner/manager catalog and inventory administration, recipe-backed products → POS/QR orders → atomic ingredient reservation → kitchen preparation and consumption → handoff → multiple partial cash/bank-transfer payments → split bill portions → approved compensating refunds → shift-linked cash reconciliation and daily net settlement reports. QR tables have revocable credentials, bilingual mobile menus, server-side price and stock checks, separate order tracking links, and the same kitchen/inventory transaction path as POS. The kitchen display is an installable offline-capable PWA: it caches a scoped ticket snapshot, persists ordered START/READY commands locally, then revalidates and reconciles them against PostgreSQL on reconnect. The pilot-hardening slice adds shared Redis-backed rate limits, manager device/station assignment and revocation, audited employee invitations, a bilingual pilot checklist, and PostgreSQL backup/isolated-restore scripts. Local database, Redis, browser and isolated-restore checks have passed; deployment and operator acceptance are still required before a restaurant pilot. Bank transfers require manager verification. Card payments remain disabled until an authorized provider is configured; the labeled sandbox adapter never simulates settlement. See [deployment hardening](docs/DEPLOYMENT.md), [security](docs/SECURITY.md), [backup and recovery](docs/BACKUP_AND_RECOVERY.md), [pilot readiness checklist](docs/PILOT_READINESS_CHECKLIST.md), [offline kitchen synchronization](docs/OFFLINE_SYNC.md), [realtime architecture](docs/REALTIME_ARCHITECTURE.md), [QR ordering lifecycle](docs/QR_ORDERING_LIFECYCLE.md), [QR security](docs/QR_ORDERING_SECURITY.md), [payment rules](docs/PAYMENT_RULES.md), [cash shift lifecycle](docs/CASH_SHIFT_LIFECYCLE.md) and [implementation status](docs/IMPLEMENTATION_STATUS.md). This is not certified production software.

## Run locally

Requires Node 22.14+, pnpm 12.4.1, Docker with a running daemon (or optional embedded PostgreSQL below). PowerShell: use pnpm.cmd if script policy blocks pnpm.ps1.

```sh
pnpm install
# Copy .env.example to .env.
# Set SEED_DEMO=true and a unique DEMO_PASSWORD of at least 12 characters for local fixtures.
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm --filter @omnihub/contracts build
pnpm dev
# Separate terminal from repository root:
pnpm worker
```

Open http://localhost:3000; API http://localhost:4000/health. Browser origin must match WEB_ORIGIN exactly; localhost and 127.0.0.1 are different origins.

Local store ID: `22222222-2222-4222-8222-222222222222`.
Accounts: owner@local.omnihub.test, cashier@local.omnihub.test, kitchen@local.omnihub.test, inventory@local.omnihub.test.
Password is DEMO_PASSWORD in the untracked .env; no production default. Seed is additive once and never resets existing data/passwords.

After signing in as owner/manager, open Administration → Tables & QR ordering to enable QR ordering, create a table, download its SVG and print it. Configure a stable random `QR_TOKEN_SECRET` of at least 32 characters before production; the API fails closed for QR order acceptance without it. Set `WEB_ORIGIN` to the public HTTPS web origin so printed QR links work on customer devices.

Without Docker: run `pnpm db:local` in a separate terminal. This starts real PostgreSQL on loopback:5432 with persistent data in .local/postgres. Do not run alongside Compose PostgreSQL on the same port. The optional development binary is PostgreSQL 18; Compose/CI use PostgreSQL 17. Redis is required for cross-device push, new sign-ins and public request limiting. Existing authenticated kitchen sessions can use the 15-second API fallback and replay durable local commands during a Redis outage; readiness stays unhealthy and new protected ingress fails closed. Realtime tests require real Redis/worker delivery.

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:redis
pnpm build
pnpm test:e2e
```

Integration tests create isolated tenants in a migrated development database without truncating existing data. Never use production DATABASE_URL. Browser tests require running API/web and seeded local credentials. See [testing](docs/TESTING.md).

After rebuilding while a production `pnpm start` server is running, restart that server before browser tests so it serves the new build consistently.

## Documentation

- [Scope and roadmap](docs/PRODUCT_REQUIREMENTS.md)
- [Domain model](docs/DOMAIN_MODEL.md) · [Architecture](docs/ARCHITECTURE.md)
- [Orders](docs/ORDER_LIFECYCLE.md) · [Kitchen](docs/KITCHEN_WORKFLOW.md) · [Inventory](docs/INVENTORY_LIFECYCLE.md)
- [Payments](docs/PAYMENT_RULES.md) · [Authorization](docs/AUTHORIZATION_MATRIX.md) · [Offline design](docs/OFFLINE_SYNC.md)
- [Cash shifts and reconciliation](docs/CASH_SHIFT_LIFECYCLE.md)
- [API](docs/API_DOCUMENTATION.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Deployment](docs/DEPLOYMENT.md) · [Security](docs/SECURITY.md) · [Backup/recovery](docs/BACKUP_AND_RECOVERY.md) · [Pilot checklist](docs/PILOT_READINESS_CHECKLIST.md)
- [Complete original requirements, preserved](docs/ORIGINAL_REQUIREMENTS.md)

Live card acquiring, automated non-cash refund disbursement, tax/discount/service-fee accounting, whole-order cancellation after payment, Telegram, advanced commercial features and production readiness remain on the roadmap. Offline-first kitchen synchronization is implemented; verified scope and environmental limits are recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md). No deployment or live partner integration is performed.

Local infrastructure recovery is verified as of 2026-10-23: Redis PING and API readiness pass; two Redis integration tests include separate API processes; the complete nine-test Playwright suite passes real two-browser Socket.IO/reconnect, device revocation, offline KDS, QR, POS/payment and cash-shift workflows. A real PostgreSQL backup was restored into a new isolated database with matching schema/counts and zero stock/financial integrity violations. Public restaurant rollout remains NO-GO until target TLS/security, off-host recovery and operator acceptance gates pass. See the [pilot checklist](docs/PILOT_READINESS_CHECKLIST.md), [testing evidence](docs/TESTING.md), [backup drill](docs/BACKUP_AND_RECOVERY.md) and [implementation status](docs/IMPLEMENTATION_STATUS.md).

