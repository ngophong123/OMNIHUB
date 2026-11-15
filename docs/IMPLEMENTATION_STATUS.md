# Implementation status

## Milestone 1 — Backend Stabilization, Realtime/Outbox Hardening & Security (2026-11-15)

**Pilot NO-GO.** Milestone 1 resolved backend stability, exception sanitization, transactional outbox concurrency/retry isolation, Socket.IO N+1 query scaling & room enforcement, RBAC/reauthorization consistency, HTTP/QR header hardening, and inactive-station/category catalog filtering on branch `fix/m1-backend-stabilization` without modifying frontend UI or adding unapproved schema migrations.

| Workstream / Gate | Status | Evidence & Scope Boundary |
|---|---|---|
| Global error sanitization & structured logging (`apps/api/src/errors.ts`) | VERIFIED | Maps Prisma (`P2025 -> 404`, `P2002/P2034 -> 409`, input codes `-> 400`, `P10*/P2024` & init errors `-> 503`), HTTP 4xx/503 operational codes, 404 `ROUTE_NOT_FOUND`, JSON parser errors, and unexpected `500 INTERNAL_SERVER_ERROR` without leaking stacks, queries, or capability tokens. |
| Outbox concurrency & fault isolation (`apps/api/src/outbox.ts`, `worker.ts`) | VERIFIED | Concurrent workers use `FOR UPDATE SKIP LOCKED`; invalid events quarantine cleanly (`MAX_QUARANTINE_IDS = 1000`); partial batches commit already-published rows before transient errors; worker uses bounded exponential jittered backoff and clean shutdown (`stop`). |
| Socket.IO room/device authorization & batched queries (`apps/api/src/realtime.ts`) | VERIFIED | Safe URI cookie decoding, strict tracking/session/device handshakes, server-room drift disconnects, `O(1)` batched PostgreSQL lookups during broadcast & 30s revalidation (`<= 4` queries verified under PG query counter), and bounded Redis subscriber teardown. |
| Security headers, RBAC, reauth & QR hardening (`http-app.ts`, `http.ts`, `domain.ts`, `pilot-admin.ts`, `cash-shifts.ts`) | VERIFIED | Explicit Helmet CSP/COOP/frameguard/referrer policies, `nosniff`, `Permissions-Policy`, `Cache-Control: no-store`, `httpOnly` logout clearing, unified `admin` RBAC + in-transaction `reauthorize`, `X-QR-Token` header SVG support, `Serializable` kitchen device registration ownership, unused `express-rate-limit` removed. |
| Inactive-station & category filtering (`http.ts`, `qr-ordering.ts`) | VERIFIED | `GET /catalog`, `QrOrdering.publicMenu`, and `GET /admin/pilot-readiness` consistently exclude products tied to inactive/deleted stations or categories. |
| Migration-free deferred schema notes | DOCUMENTED | **No unapproved migrations executed in M1:** (1) `Movement(tenantId, storeId, createdAt)` composite index gap noted for future store inventory ledger queries (`GET /inventory/movements`); (2) persistent `Outbox` dead-letter/attempt columns deferred beyond M1's bounded in-memory quarantine. |
| Local verification vs hosted CI coverage | PARTIALLY VERIFIED | Local Windows `embedded-postgres` run verified `46/46` unit + `31/31` PG integration tests (`V8: Stmts 64.97%, Branches 61.26%, Funcs 57.67%, Lines 76.36%`), `typecheck`, `lint`, `security:hygiene`, `audit`, and `build`; `pnpm test:redis` and `pnpm test:e2e:ci` are **BLOCKED** locally (no Docker/Redis) pending PR execution in hosted CI. |

## Milestone 0.2 — CI/CD, E2E, Coverage & Security Foundation (2026-11-14)

**Pilot NO-GO.** Engineering quality automation, full-stack CI execution, V8 coverage gates, and CI security controls are verified on branch `engineering/m02-quality-foundation` (`f9c8741`, pending PR merge to `main`), while operational DR, offsite storage/monitoring, RPO compliance, and physical pilot UAT remain open blockers.

| Workstream / Gate | Status | Evidence & Scope Boundary |
|---|---|---|
| CI build, unit/PG coverage & Redis integration | VERIFIED | GitHub Actions `checks` Run `#43585662222` (`verify`): Postgres 17 + Redis 7 services; `34/34` unit + `27/27` PG integration tests (`Stmts 49.33%`, `Branches 51.66%`, `Funcs 49.51%`, `Lines 58.3%`) meeting per-module and `ci`-scoped global V8 floors; `pnpm test:redis` (`2/2`); `backend-coverage` artifact uploaded. |
| Headless full-stack Playwright E2E in CI | VERIFIED | GitHub Actions `checks` Run `#43585662222` (`e2e`): `pnpm test:e2e:ci` ran live built `api`, `worker`, `web`, Postgres 17, Redis 7, and Chromium; all `10/10` workflows passed (including auth/store boundary and inventory adjustment/ledger) with `AUTH_LOGIN_RATE_LIMIT=10` preserved. |
| Production dependency audit, hygiene & CodeQL | VERIFIED | GitHub Actions `security` Run `#43585662264` (`audit`, `codeql`): `pnpm audit --prod --audit-level high` clean, `pnpm security:hygiene` clean (`142` files, `0` violations), `sh -n` clean, CodeQL `v4` (`security-extended`) passed. |
| PR dependency review & local Windows web build | PARTIALLY VERIFIED | `dependency-review` is wired for `pull_request` events (`skipped` on branch push); local Windows `typecheck`, `lint`, `test:coverage` (`34/34`), `security:hygiene`, `audit`, `contracts build`, and `api build` pass while Windows `@omnihub/web` local build remains blocked on `.next` ACL `EPERM` (`Linux CI build PASS`). |
| Multi-branch / multi-warehouse & live payments | NOT IMPLEMENTED | Runtime store switching, inter-warehouse transfers, webhook signature verification, live card acquiring (`SANDBOX_ONLY`), tax/discount models, and WAL PITR remain unimplemented. |
| Off-machine DR, 900s RPO & restaurant UAT | BLOCKED / FAILED | Host outage drills failed 900s RPO (`212,374 s` on `2026-10-26`); independent backup target/monitor/alerts and physical staff UAT ([PILOT_UAT.md](PILOT_UAT.md)) remain unprovisioned/unverified. |

## DR recovery-point gate — 2026-10-26

**Pilot NO-GO.** On host restart, local monitoring reported a **212,374-second** recovery-point age, failing the 900-second RPO. Docker Engine 29.1.2 was started safely; all databases, volumes, prior backups and historical invalid artifact were retained.

| Requirement | Status | Current evidence |
|---|---|---|
| Fail-closed remote RPO check | VERIFIED | `monitor.sh check` now decrypts/restores and validates checksum, PostgreSQL archive and manifest point/size on every run; a newest invalid 80-byte fixture archive failed both check and verify. |
| Offsite copy validation | VERIFIED | `offsite.sh copy` passed across encrypted tmpfs repositories; stale source and unavailable remote left the pointer unchanged. |
| Current local backup/restore | VERIFIED | Snapshot `3ebfe1b6` restored to new retained `omnihub_staging_restore_1793012409724_59d46066`: 37 tables, 13 migrations, zero critical errors, API/login/catalog/store/tenant PASS, 39.285-s local recovery. |
| Actual off-machine recovery and paging | BLOCKED | No approved destination, independent monitor or recipient. |
| Pilot RPO | FAILED | Host restart exposed 212,374-s point age against 900-s target. |
| Restaurant RTO and physical UAT | UNVERIFIED | No site cutover or physical-device acceptance. |

Lint/typecheck and unit 27/27 passed this continuation. Shared application code was unchanged, so production app build, PostgreSQL/Redis integration and Playwright were not rerun; their prior results are historical.

## Disaster recovery hardening continuation — 2026-10-24

**Pilot NO-GO.** The host-outage RPO policy violation remains open. Five 300-second scheduled backups verified cadence while the host was up; at restart the newest recoverable point was 35,797 seconds old, and local alerting resumed only then. Actual transaction loss and host-down duration are unknown. The selected architecture is verified five-minute local dumps plus an approved independent encrypted Restic copy and an independently operated monitor; the latter two are not provisioned.

| Requirement | Status | Current evidence and limit |
|---|---|---|
| Manifest-bearing encrypted local backup | VERIFIED | Backup service built and safely recreated without volume reset. New snapshot `2e983596` passed dump, archive, checksum, repository, decryption and manifest checks. Historical invalid 80-byte artifact remains retained. |
| Isolated restore and app validation | VERIFIED | New retained DB `omnihub_staging_restore_1792798366650_5ebbf990`: 37 tables, 13 migrations, zero critical integrity/relationship defects, API readiness/login/catalog and tenant/store isolation. Measured local recovery 17.259 s. |
| Disposable independent-repository tooling probes | VERIFIED | Network-disabled container used source volumes read-only, copied a verified snapshot into tmpfs, verified decrypt/restore and detected stale remote point, missing primary health, unavailable repository and stale restore proof. No real off-host failure was executed. |
| Encrypted off-machine copy and operator notification | BLOCKED | No approved host/storage, independent monitor or recipient credentials. Tooling is prepared and requires explicit allowlists; no backup was externally uploaded or alert delivered. |
| 15-minute RPO during host loss | FAILED | A 35,797-second-old recovery point at restart violates the 900-second age threshold; actual data loss is unknown. |
| Pilot-site 60-minute RTO and physical UAT | UNVERIFIED | Local 17.259-s drill excludes detection, decisions and cutover; restaurant devices and staff have not been tested. |
| WAL archiving/PITR | NOT IMPLEMENTED | The pilot design uses complete five-minute logical dumps; PostgreSQL WAL cannot replay from a `pg_dump`. Reassess if measured transfer/recovery violates objectives. |

Only backup scripts, backup image and documentation changed. The historical full Playwright 9/9, unit 27/27, PostgreSQL 27/27 and Redis 2/2 results below were not rerun in this continuation; see [TESTING.md](TESTING.md) for current targeted evidence.

Final local backup image also added allowlisted HTTPS alert delivery for backup/offsite failures. Its `d6f1118a` snapshot restored into a second new retained DB `omnihub_staging_restore_1792798675143_22675dc8` with 37 tables, 13 migrations, zero critical integrity/relationship findings, API/login/catalog/isolation PASS and **32.209 s** local service recovery. The independent monitor's final disposable probes and notification destination rejection passed. No approved external recipient or offsite repository exists, so delivered alerts and off-machine recovery are BLOCKED.

The exact final image after the last monitor-configuration fix produced `04ed880f`; backup health passed. A third isolated retained DB `omnihub_staging_restore_1792798881847_952394ed` passed 37 tables, 13 migrations, zero critical errors, API/login/catalog/store/tenant isolation, with **25.839 s** local service recovery. This is the current final-image timing; both earlier restores remain evidence.

## Final backup/DR verification — 2026-10-24 local time

**Pilot NO-GO.** The backup validation and recovery implementation is working in local staging. Docker Engine 29.1.2 was accessible using elevated commands; the ordinary sandbox lacked named-pipe permission. Existing development/staging data, historical restore databases, invalid 80-byte backup evidence and all Docker volumes were preserved. This section supersedes the Docker-blocked assessment below.

| Requirement | Status | Current evidence and limit |
|---|---|---|
| Backup integrity, persistent verified pointer, overlap/failure detection | VERIFIED | Scheduler checks dump exit, archive size/readability, SHA-256, Restic repository and exact decrypted snapshot before advancing `/state/verified.json`; prior injected dump failure/truncation/overlap tests did not advance it. Restart logged `BACKUP_STALE` and `PG_DUMP_FAILED` without false success. |
| New isolated recovery drill | VERIFIED | Snapshot `24701e94` restored to `omnihub_staging_restore_1792796154670_d5977108`; 37 table names, 13 migrations and six explicit relationship checks passed, as did owner login, catalog, API connectivity and store/tenant isolation. Actual service recovery **25.666 s**. |
| Scheduled backup observation | VERIFIED | Five scheduled verified points over 1,200 s, at 22:59:10/23:04:10/23:09:10/23:14:10/23:19:10 UTC, all 300-s gaps. Evidence `.local/staging/backup-schedule-observation-20min-20261024.json`; the earlier 15-minute report remains retained. |
| 15-minute RPO across host outage | FAILED | Previous valid-backup gap was 19 minutes; on this restart verified backup age was 35,797 s. Local alerting resumed only with the host. No off-machine monitor/copy exists. |
| Off-machine encrypted recovery and delivered paging | BLOCKED | Allowlisted offsite tool exists but approved repository, credentials and operator alert destination were not supplied. No external copy or independent restore was performed. |
| Local 60-minute RTO target | VERIFIED | Measured 25.666 s from drill start to application probe; excludes incident declaration and site cutover. |
| Restaurant-site RTO and real-device acceptance | UNVERIFIED | No restaurant infrastructure, staff or physical-device drill. Bilingual scenarios remain in [PILOT_UAT.md](PILOT_UAT.md). |
| Final software regression | VERIFIED | Lint, typecheck and production build exit 0; unit 27/27, PostgreSQL integration 27/27, Redis integration 2/2. A POS stale-catalog defect caused an initial 8/9 browser run; refreshed product selection fixed it, targeted test passed 1/1, and the final complete HTTPS suite passed 9/9 in 1.7m. |

The final web container used image `sha256:3d0d851e66be10f5f08e344dec8743cc6ee3e76f852b340a729d701855d4ec4c`; the existing API/worker application image remained in service. Strict-CA web and API readiness returned HTTP 200. No push, merge or public deployment was made.

## Backup reliability continuation — 2026-10-24

**Pilot decision: NO-GO.** The backup scheduler now checks `pg_dump` exit, archive size/readability, Restic integrity, exact snapshot decryption and SHA-256 before advancing persistent `/state/verified.json`. It records duration/failure reason, prevents overlap with `flock`, schedules every 300 seconds and monitors verified recovery-point age every 30 seconds against a 900-second limit. Local fault probes observed `PG_DUMP_FAILED`, `BACKUP_TRUNCATED`, `BACKUP_OVERLAP` and `BACKUP_STALE` without a false verified pointer. The historical invalid 80-byte snapshot is preserved. Two valid recovery points were 300 seconds apart; the previous 19-minute gap FAILED the 15-minute target and sustained compliance remains UNVERIFIED.

The 2026-10-23 isolated restore VERIFIED archive decryption/checksum, 37 tables, 13 migrations, critical counts, owner login and store/tenant isolation in a new database. Local service recovery took 14.564 seconds against a proposed 60-minute RTO. Additional explicit relationship assertions were added after that drill and remain UNVERIFIED pending rerun. Off-machine copy and physical-device UAT are BLOCKED. The approved-destination-only offsite tool is prepared but no upload was attempted. Bilingual scenarios are in [PILOT_UAT.md](PILOT_UAT.md).

This continuation's unit tests passed 27/27. Final lint/typecheck/build results are in [TESTING.md](TESTING.md); Docker-dependent reruns remain BLOCKED while the local Windows service/WSL access cannot start. Historical 9/9 Playwright results below are not a new run.

## Interrupted staging verification completed — 2026-10-23

**Pilot: NO-GO.** Isolated local staging is running with final API image `sha256:e6914c85f5360363fb65fb53c6ecdcba046fccc2408ff8a02dac2ea13baf967d` and web image `sha256:c40d34d09c19dd3e08ae8388f7bd23a435df47abe55ef58b9d843f7b7c490a1a`. `docker compose -f deploy/compose.staging.yml build api web` completed, all service healthchecks recovered, and the full HTTPS Playwright suite passed **9/9 in 2.0m** on those images. A final repeat after the backup-script change passed **9/9 in 1.4m**. Lint, typecheck and 27/27 unit tests pass. Earlier staging integration passed 27/27 PostgreSQL tests, and earlier failure drills passed; these were not silently reclassified as new runs.

| Area | Status | Evidence / remaining risk |
|---|---|---|
| Application regression | VERIFIED | Full 9/9 browser workflow covers POS/payment/refund, shifts, catalog, QR/mobile, kitchen realtime, offline replay/conflict and device revocation. The UI editor race fixed before this run remains covered. |
| Staging dependencies and transport | VERIFIED | PostgreSQL/Redis/API/web/worker/backup healthy after Desktop restart; Redis PONG, trusted local CA for 8443/8444, API `/ready` 200, evil Origin 403, redirect 308. |
| Local restore read path | VERIFIED | Retained isolated DB has 37 tables, 13 completed migrations, no unvalidated constraints, 1 store/4 users/3 products. SELECT-only app-role grant on that DB enabled actual Prisma reads; isolated API `/ready` and `/health` 200, anonymous protected endpoints 401. App role INSERT privilege is false. |
| Full restored-service auth/operation | UNVERIFIED | Valid login would write a new session to the retained evidence DB, so it was intentionally not attempted. One-store/zero-order snapshot cannot prove restored cross-store or financial behavior. Use a new isolated recovery copy for that drill. |
| Backup scheduler failure handling | VERIFIED | Fixed `backup.sh` to stop on each failed dump/archive/check command. An invalid-host probe exited 1. A new encrypted 265,351-byte snapshot (`31ce207a`) passes Restic and archive-list checks. |
| Backup RPO during outage | FAILED | Old scheduler falsely marked an 80-byte snapshot (`6ddbb752`) as verified. Valid snapshots were approximately 19 minutes apart, exceeding the 15-minute target. Existing invalid snapshot was retained, not deleted. |
| Off-host backups, restaurant devices, operator acceptance | BLOCKED | No off-machine destination or physical restaurant hardware supplied. See PILOT_READINESS_CHECKLIST.md for corrective actions. |
| Git working tree | BLOCKED | Repository copy contains no `.git`; Git cannot enumerate uncommitted changes. No push, merge or deploy was attempted. |

The source change in this final pass is a fail-closed backup scheduler fix. Existing PostgreSQL data, Redis data, Docker volumes and all prior snapshots were preserved. The previous implementation sections below remain historical evidence, not a claim of real-site readiness.

This file is updated after executed checks. Specifications describe target behavior; do not interpret them as verification evidence.

## Latest infrastructure recovery evidence — 2026-10-23

**Requested local recovery/verification milestone: VERIFIED. Public restaurant rollout: NO-GO pending deployed-infrastructure and operator acceptance.** This section supersedes the historical blocked environment notes below.

Docker Desktop 29.1.2 on `desktop-linux` is accessible through authorized execution outside the sandbox. The normal sandbox still cannot read the user's Docker configuration/pipe; that restriction is not Docker Engine unavailability. Redis was inspected and verified on `omnihub_redis_data`. On resuming October 23, Docker Desktop/WSL and the development PostgreSQL cluster were stopped. Docker Desktop was safely reopened and PostgreSQL started from its existing data directory. The old Redis container was absent but its named volume remained; Compose created only the missing Redis container/network using that retained volume. No existing container, volume, distribution or database was deleted, reset or replaced.

Actual fixes found during verification:

- The limiter now initiates its Redis connection at API startup instead of making the first protected request initiate it and return a spurious 503. Offline queueing stays disabled and Redis failures still fail closed.
- The KDS waits for successful server device registration before opening its authenticated socket. Its real socket drives the connection indicator; server disconnects caused by station reassignment revalidate before reconnecting, and revoked devices stay denied. The visible kitchen refresh action uses KDS synchronization.
- Browser tests now carry required device headers, scope administration selectors correctly, wait for QR configuration, and inspect real Socket.IO frames. A real forwarding WebSocket proxy forces transport closure; ordinary offline emulation was found to leave an existing socket open. Revocation assertions accept actual socket closure (including proactive client closure after a 403), then independently verify that a fresh server handshake is rejected.
- A cashier read after an observed frame took 5.93s in one run; the trace showed a slow authoritative HTTP response, not stale-state overwrite. The test retains a five-second push/kitchen-visibility assertion after order acceptance and uses ten seconds for cashier rendering. This is not a performance certification and polling cannot substitute for the required frame assertions.

| Requirement | Status | Executed evidence |
|---|---|---|
| Redis and API dependency health | VERIFIED | Redis PING = PONG; `/ready` = HTTP 200 with `database: ok`, `redis: ok`; actual browser logins succeed. |
| Shared Redis limiting | VERIFIED | 2/2 tests: real atomic Redis clients/TTLs plus two separate built API processes sharing one HTTP login limit (400, 400, then 429). |
| Socket.IO and reconnect | VERIFIED | Final browser test sees acceptance and preparation frames in separate cashier/kitchen clients, closes the actual transport, requires a new authenticated handshake and receives later events. |
| Offline synchronization/conflicts | VERIFIED | Final browser suite passes cached reload, durable ordered START/READY replay, duplicate confirmation and dependent-command conflict review. |
| Device authorization/revocation/audit | VERIFIED | Final browser test rejects a missing device handshake and revoked register/read/sync/reconnect, confirms socket closure and unchanged order state after rejected replay, and verifies the audit action. |
| Existing browser workflows | VERIFIED | Final complete Playwright run: **9/9 passed** in 1.3m; includes POS/payment/refund/report, cash reconciliation, catalog, QR/mobile, offline KDS and pilot device workflow. Evidence: `.local/infra-recovery/resume-20261023/e2e-verified`. |
| Static/build/domain/database checks | VERIFIED | Lint and typecheck pass after final test changes. During this milestone the final application implementation passed production build, 16/16 unit tests and 27/27 real PostgreSQL integration tests; 13 completed migrations are up to date. |
| Backup and isolated restore | VERIFIED | PostgreSQL 18.6 tooling container; readable 2,336,896-byte archive and matching SHA-256; new isolated database retained; all 37 table counts, schema metadata and 13 completed migrations match. Restore 5.301s, restore plus verification 71.983s. Six integrity checks return zero violations. |
| Backup/restore persistence after interruption | VERIFIED | On October 23 the backup checksum, all 37 restored table counts and 13 completed migrations were checked again successfully. |
| Target TLS/proxy/secrets/device acceptance | BLOCKED | No deployed pilot environment or restaurant hardware acceptance evidence. |
| Scheduled encrypted off-host recovery and active-order process-failure drills | NOT IMPLEMENTED | The local restore/transport tests do not replace these operational procedures. |

The first full browser attempts failed on the connection indicator, a missing device header, overly strict administration selectors, an offline-emulation assumption and timing/configuration races in tests. These failures were investigated and the complete suite rerun; they are not omitted or relabeled as earlier passes. Database fixtures, stock reservations, payments and audit history from tests remain retained. Backup files and traces stay in ignored local storage. Nothing was pushed, merged or deployed. Detailed classifications are in [PILOT_READINESS_CHECKLIST.md](PILOT_READINESS_CHECKLIST.md) and restore evidence in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).

## Milestone 0 — domain and architecture: IMPLEMENTED (specification)

Policies, authorization matrix, command contracts, offline design and corrected phases are documented. Original requirements are retained verbatim in ORIGINAL_REQUIREMENTS.md. MVP decisions are explicit: VND integer dong, no tax/discount/refunds, full cash after handoff, per-unit items, consume at preparation start, no automatic restocking after preparation, 04:00 Vietnam business-day cutoff.

## Milestone 1 — runnable foundation and first vertical slice: IMPLEMENTED AND TESTED within the scope below

Files: apps/web (Next.js 16.4.2, React 19, central vi/en dictionaries, POS/orders/kitchen/stock/reports and responsive administration), apps/api (NestJS 12.2, auth/permission/domain transaction services, REST, Socket.io and worker entrypoint), packages/contracts (Zod commands/events/admin schemas), prisma (schema and additive migrations including invariants/immutable ledger/catalog and recipe revision backfill), docker-compose.yml (PostgreSQL/Redis), scripts/local-postgres.ts, tests, CI and practical README.

Working behavior:

- Password KDF, opaque cookie sessions, logout revocation, current-membership revalidation, store-scoped reads/writes and origin enforcement.
- Active seeded catalog with recipes; acceptance snapshots price/recipe, creates station tickets and atomically reserves all ingredients.
- Per-unit START consumes reservations, READY and HANDOFF are distinct; optimistic aggregate version prevents lost updates.
- Partial cancellation releases unprepared stock or classifies consumed stock as waste without a second decrement.
- Initial cash settlement with change, terminal paid order, immutable business-date report and ledger reconciliation; the one-payment limit from this first slice was removed in milestone 4.
- Transactional audit/outbox/command receipts, same-key retry, different-payload conflict; SQLSTATE serialization/deadlock retry.
- Authorized store realtime invalidation, re-subscription after Redis recovery, reconnect/15-second REST refresh.
- vi/en navigation/forms/workflow labels, responsive desktop/mobile/tablet layouts, role-aware controls backed by server policies.

## Executed verification (local, 2026-10-21)

| Command/check | Result |
|---|---|
| pnpm install --frozen-lockfile | Passed; lockfile resolves |
| pnpm db:generate | Passed, Prisma 6.19 client |
| pnpm db:migrate; prisma migrate status | Four additive migrations applied; up to date |
| pnpm db:seed | Explicit local fixtures created, password generated into ignored .env, never logged |
| pnpm lint | Passed, ESLint 10.13 / typescript-eslint 8.72 |
| pnpm typecheck | Passed for all apps/contracts plus tests, seed and scripts |
| pnpm test | 9 unit tests passed, including recipe/unit/pricing checks |
| pnpm test:integration | 13 real PostgreSQL tests passed on the milestone-2 local PostgreSQL database; the earlier 12-test suite also passed on PostgreSQL 17 |
| pnpm build | Contracts/API/web production builds passed |
| pnpm test:e2e | 4 Playwright tests passed against running API/web/PostgreSQL/Redis/worker |
| Docker Compose Redis | Healthy; actual Redis subscriber and worker publish exercised |
| Browser viewport checks | Desktop 1280x720, mobile 390x844, tablet 820x1180; POS and admin widths checked without horizontal overflow; screenshots generated under ignored test-results |

Integration coverage: complete slice; price/recipe snapshot stability; cash replay/duplicate rejection; last-portion multi-ingredient race; rollback on later shortage; concurrent same-key deduplication; changed-payload replay rejection; pre/post-start partial cancellation; stale/duplicate START; cross-tenant object/foreign-key rejection; revoked session/current role; SQL balance/immutable ledger constraints; distinct overlapping recipes with reversed input; underpayment rollback/paid cancellation; concurrent kitchen mutations. Twelve named tests each cover multiple assertions, not twelve isolated API paths.

Browser coverage: real login, POS acceptance, item preparation/handoff, cash/change, report, language switch, mobile/tablet overflow check, logout; separate kitchen device receives committed order within 5 seconds (before 15-second poll), kitchen role denied POS/report; anonymous and Origin/validation rejection.

Initial failing checks were not hidden: Prisma payment composite uniqueness fixed; raw-query serialization error P2010/40001 added to retry; Redis subscription after startup without Redis fixed. Tests were rerun after fixes. Optional embedded PostgreSQL 18.4 ran locally because Docker was initially unavailable. Docker Desktop subsequently started; Redis ran in Compose. A separate PostgreSQL 17 Docker instance on loopback:5433 passed both migrations and all 12 integration tests. Hosted CI file is prepared, not a passing hosted run. Browser execution during a rebuild of the running Next production server failed to hydrate; restarting that server against the completed build restored the passing suite.

Redis recovery drill: stopped the development Redis container, restarted API while Redis was absent, then restored Redis. PUBSUB NUMSUB confirmed the API re-subscribed (1 subscriber); the complete three-test browser suite passed after recovery, including kitchen push delivery before fallback polling.

Final source uses a shared enum of schema-versioned event types; production build, lint, full typecheck, PostgreSQL integration and all three browser tests passed after that change. Test servers/containers were stopped after verification, with persistent data retained. Restart using README instructions; when using embedded PostgreSQL start only the Compose Redis service (`docker compose up -d --wait redis`).

## Milestone 2 — production-oriented catalog and inventory administration: IMPLEMENTED AND TESTED

Server APIs provide scoped CRUD and server-side validation for categories, products, stations and ingredients; product search/filter/pagination; recipe unit normalization and version history; variants with absolute prices and recipe multipliers; modifier groups/toppings with selection limits, price deltas and ingredient additions; manual availability; stock receipts, reasoned adjustments and paginated movement history. Operational writes run in serializable idempotent transactions and append audit/outbox records. Duplicate names, stale versions, invalid units, incompatible station/category links, unsafe ingredient unit changes, in-use ingredient archival, active-menu station/category deactivation and recipe/price range errors are rejected.

PostgreSQL remains authoritative. Migrations add catalog entities/columns and check constraints without dropping rows, extend the immutable movement ledger for receipts, and backfill recipe version-one revisions from existing recipes. Accepted order lines persist calculated VND prices, selected variant/modifier details and composed base-unit recipe snapshots; subsequent menu edits do not alter old orders or reservations. Stock availability uses atomic conditional balance updates, and concurrent reservation integration tests prove no negative availability.

Owner/manager administration is available in Vietnamese and English for catalog, ingredients, categories, stations and receipts. The POS supports variant and modifier selection, displays calculated prices, and disables unavailable base/variant choices. Playwright verifies real catalog/receipt/variant/topping workflows and mobile/tablet widths; existing POS → Kitchen → Inventory → Payment regression coverage remains active.

Additional executed verification for this milestone: `pnpm lint`, `pnpm typecheck`, `pnpm test` (9 unit tests), `pnpm test:integration` (13 PostgreSQL tests), `pnpm build`, and `pnpm test:e2e` (4 browser tests). Migration status reports four migrations applied on the local PostgreSQL instance. These checks ran against local development services and fixture data; they are not a production deployment or operational load/security certification.

One combined run of lint, typecheck, unit and integration commands in parallel briefly starved the local PostgreSQL transaction pool and timed out two integration cases; rerunning the integration suite alone passed all 13 tests. Full E2E was rerun after the final UI filter/pagination changes and passed 4/4.

## Milestone 3 — cash shift management, reconciliation and financial auditability: IMPLEMENTED AND TESTED

PostgreSQL migrations `202610230001_cash_shifts` and `202610230002_cash_shift_state_machine` add store-scoped registers, shifts, immutable cash movements and nullable shift linkage for historical payments. Existing payments were left untouched; new cash settlements require and link an open shift assigned to the acting cashier. New stores receive a default register. Owners/managers can create registers and assign an active same-store cashier/owner/manager; cashiers can open their own shift. A store/register or cashier cannot have more than one open or closing shift.

Cash shifts capture opening float, configured Vietnam business date, register, cashier and state. Cash-in/out, payment-linked refunds and compensating corrections are integer VND append-only movements with reasons and idempotency keys. Expected drawer cash sums opening float, net `Payment.amount` once, and signed cash movements; tendered/change are not double-counted. Payments and movements lock/increment the shift in the same serializable transaction as their ledger write. Close records expected/count values and variance; matching counts pass through `OPEN → CLOSING → CLOSED` atomically, while a reasoned discrepancy remains `CLOSING/PENDING` until an owner/manager approval. Database checks/triggers freeze closed shifts and close snapshots and enforce allowed state transitions. No historical payment is rewritten, and no shift can be reopened.

Store-scoped APIs provide register and cashier assignment lookup, register creation, shift open/history, cash movements, shift close and manager approval. The responsive Vietnamese/English cash panel covers these actions and shows open/pending shifts and closed reconciliation history. Every financial command writes the audit record, idempotency receipt and outbox event in its PostgreSQL transaction. The lifecycle rules for handover, late/failed payments, refunds, correction entries, legacy payments and business-day crossing are documented in [cash shift lifecycle](CASH_SHIFT_LIFECYCLE.md).

Verification on the local persistent PostgreSQL database: `pnpm db:migrate` applied both new additive migrations and `prisma migrate status` reported up to date; existing development rows were retained. Final `pnpm test` passed 10 unit tests, `pnpm test:integration` passed 17 real-PostgreSQL tests, `pnpm test:e2e` passed 5 Playwright tests, and `pnpm lint`, `pnpm typecheck` and `pnpm build` passed. E2E exercised shift opening, linked POS cash collection, cash-in/out, matching close, discrepancy approval and desktop/tablet/mobile layouts. The payment/close race test verifies a committed payment is included in the close snapshot or the close is rejected as stale; cross-store access, same-key payment replay, bounded refund movements, manager audit and immutable-history behavior are covered by integration checks. These are local development tests, not production load/security certification.

The first Playwright attempt exposed a cashier dropdown default race (cashier options loaded after the uncontrolled select initialized); it was changed to controlled selection and the full 5-test suite passed. That exploratory run wrote test-only register/shift/order fixtures to the preserved local database; test-generated shifts were closed or approved through the audited API, and no rows were deleted.

## Milestone 4 — multi-method payments, partial payments, bill splits and refunds: IMPLEMENTED WITH LIMITATIONS

Additive PostgreSQL migrations `202610240001_multi_method_payments` through `202610240004_refund_business_date` retain prior payments and assign legacy idempotency markers; they remove the old one-payment-per-order indexes and add scoped payment/refund/split records, unique external references, integer VND checks, immutable ledgers and controlled one-time status transitions. Multiple payments can settle in parts. Cash postings require the current cashier's open shift; manual bank transfers reserve the due amount until owner/manager verification; card checkout is disabled through a labeled `SANDBOX_ONLY` adapter that always rejects. Order row locks, serializable transactions, idempotency receipts and uniqueness constraints prevent overpayment and duplicate references/callback effects.

Bill portions can be defined by integer amount or selected item snapshots, and separate payments can be allocated to a portion without duplicating tickets, order items or inventory reservations. Refund requests retain original payment references and reasons; managers approve/reject them. Item refunds are capped against the immutable item snapshot; all refunds are capped against the payment and legacy cash refund movements. Cash refund approvals append a movement to an open shift and never modify closed shift history. Refunds never restock consumed ingredients. Unpaid orders can be cancelled atomically: reserved stock is released while already-consumed ingredients become waste. Pending transfers can be manager-verified or failed with a reason; failed attempts remain in history and release their reserved balance. Payment history and daily reporting expose settled amounts, pending amounts, remaining balance, approved refunds and net collected VND. All financial commands generate audit/outbox entries and all read/write paths are store-scoped.

The bilingual checkout supports partial amounts, cash/bank selection, split portions, payment history, bank verification and refund request/approval on responsive layouts. API and UI expose outstanding balance and keep provider-backed card selection disabled.

Local verification: additive migrations applied successfully to the preserved local PostgreSQL database; all 10 migrations report applied. `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` pass (12 unit tests). `pnpm test:integration` passes 22 real-PostgreSQL tests, including payment partials, amount/item splits, concurrent overpayment prevention, failed/verified transfers, duplicate references/callbacks, store scoping, unpaid cancellation, item-level refund, cash-shift refund movement and existing POS→Kitchen→Inventory→Payment regressions. The updated checkout browser test passes with a split allocation, two cash tenders, item refund approval and unpaid-order cancellation; the final built-app Playwright suite excluding the Redis-only realtime test passes 4/4 and covers cash shifts, admin workflows and mobile/tablet layouts. A full five-test browser run passed 4 and failed the existing realtime kitchen assertion because the local Redis service is unavailable (`worker` repeatedly logs `OUTBOX_RETRY`); Docker/Redis is not installed in this environment. The standard Playwright output folder also contains a locked prior screenshot, so direct Playwright runs used a fresh `.local` output directory. No development rows were deleted. Do not treat this as provider settlement, tax/accounting compliance, load testing or production certification.

Limitations: card processing has no live adapter or credentials; bank transfers and non-cash refund disbursements are manually verified outside a provider; taxes/discounts/service fees do not yet exist in the order model; there is no whole-order cancellation after settlement, automatic expiry for pending transfers, automated refund disbursement callback, or formal accounting export. Accessibility, production load, backup/restore, penetration review, TLS/deployment and full offline behavior remain unverified.

## Milestone 5 — production-oriented QR table ordering and customer tracking: IMPLEMENTED; VERIFICATION MIXED

Additive migration `202610250001_qr_table_ordering` adds store-scoped restaurant tables, hashed/revocable QR credentials, expiring table sessions, per-order customer tracking hashes, product image URLs and preparation-note snapshots. The migration was applied to the preserved local PostgreSQL database; the final `prisma migrate status` reports 11 migrations and an up-to-date schema. No rows were deleted.

Owners/managers can enable QR ordering per store; create, rename, disable and rotate table credentials; close sessions; and download/print SVG codes. QR and session secrets are unpredictable bearer tokens; only hashes are stored. Rotating a table credential invalidates prior sessions. Sessions expire after four hours, and each order remains a separate financial obligation even when several orders originate from the same table session. Public access is limited to menu/session creation, session-scoped order submission and one-order tracking; administrative APIs remain cookie-authenticated and store scoped.

The Vietnamese/English mobile menu supports search, categories, product images, variants, modifiers/toppings, stock-derived availability, notes and a cart. It sends product selections and an idempotency key, never an authoritative total. The server recalculates prices, checks store/table/catalog/recipe availability, and delegates acceptance to the same serializable POS transaction, so a QR order reserves stock and creates kitchen tickets once while writing its audit/outbox record. Customer tracking exposes only the order's fulfillment state. Socket.io customer notifications are order scoped and trigger a safe REST refresh; the UI also polls every 12 seconds. No customer cancellation or payment flow is exposed.

Verification on 2026-10-22 against the local development database: `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd test` (13 unit tests), `pnpm.cmd exec vitest run tests/integration --testTimeout=20000` (24 real PostgreSQL integration tests), `pnpm.cmd build`, and `prisma migrate status` all passed. Playwright passed five non-Redis workflows: POS→Kitchen→Payment→Report regression, cash shifts, origin/anonymous validation, owner catalog/table administration, and mobile QR ordering/tracking. The QR browser test creates a real development order; fixtures and financial/stock history were retained.

The kitchen realtime E2E was rerun and remains **unverified/failed in this environment**: the local worker retried outbox delivery while Redis was unavailable, so the receiving kitchen device did not see the ticket before the test's five-second assertion. The Docker service/daemon could not be started here. This is not counted as a realtime pass; only the REST fallback and safe customer tracking path are covered by current successful checks. The public API limiter is process-local, so a multi-instance deployment must use a shared rate-limit store and correctly configured trusted proxies. Production TLS, rate/load testing, accessibility audit, external asset review and operational security review remain outstanding.

## Next highest-priority pilot milestone at the end of Milestone 5

Offline-first kitchen operation: installable KDS with an explicit local cache, durable ordered command queue, duplicate-safe replay, stale-state/conflict handling and reconnect reconciliation. Validate it under interrupted network conditions without weakening PostgreSQL as the source of truth. Follow with restaurant onboarding and operational readiness (device/session administration, backup/restore drills and deployment/security hardening); keep card processing disabled until an authorized provider integration passes reconciliation tests.

## Milestone 6 — offline-first kitchen display and command recovery: IMPLEMENTED; VERIFIED WITH REALTIME LIMITATION

The KDS now runs as an installable web app with a service worker that caches the app shell and static assets only; it does not cache API responses. A scoped IndexedDB store keeps a minimal ticket snapshot, device identifier, ordered sequence counter and durable START/READY command queue. It does not store prices, payments, employee data, credentials or session tokens. Queue writes complete before the UI shows the optimistic transition. On reconnect, clients fetch the PostgreSQL-backed state and replay commands in order using device registration, command IDs, sequence numbers and expected order versions. The API reuses the existing authorized, transactional kitchen command path, including its state/version checks, inventory, audit, outbox and receipt effects. Duplicate replay is safe. Conflict, rejected and dependent blocked commands remain visible for operator review; server state stays authoritative. Session expiry requires a fresh sign-in before replay. Logout clears the cached identity and ticket snapshot; queues remain partitioned by tenant/store/user and are never replayed under another identity.

Only kitchen START and READY transitions are available offline. New orders, handoff, payments, inventory writes and catalog administration require connectivity. The UI reconnects to Socket.IO when available and refreshes from the API every 15 seconds as a safe fallback. Device registration and revocation APIs are store scoped; server authorization is rechecked on every sync. Device records contain scope and timestamps, not bearer credentials. This is a development/pilot feature, not a claim of production certification.

Verification on 2026-10-22 against the preserved local PostgreSQL database: additive migration `202610260001_kitchen_devices` is applied and Prisma reported all 12 migrations up to date. `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd test` (14 unit tests), `pnpm.cmd exec vitest run tests/integration --testTimeout=20000` (26 PostgreSQL integration tests), and the combined `pnpm.cmd build` passed. Integration coverage includes command ordering/idempotency, a stale expected version without duplicate effects, and device store/user scoping and revocation. The final production Playwright run passed 7/7 workflows excluding only Redis realtime: existing POS→Kitchen→Cash/report, cash shifts, offline cache/ordered queue/replay, stale-server conflict with dependent-command block, origin and anonymous validation, real catalog administration, and mobile QR order/tracking. Offline scenarios verified mobile/tablet overflow and authoritative PostgreSQL reconciliation. The E2E harness now accepts `API_BASE_URL`; local runs used port 4001 to avoid modifying an unrelated listener on 4000. `AUTH_LOGIN_RATE_LIMIT` is configurable, defaults to 10/minute and is capped at 100; the test API alone used 100 to avoid suite-wide login throttling. Browser checks add development transactions; no database rows were deleted.

Redis-dependent cross-device push remains unverified. The realtime Playwright test was explicitly rerun and failed because a second kitchen client did not receive the outbox event before the five-second pre-poll assertion. On this host `127.0.0.1:6379` is unreachable and `com.docker.service` is stopped; the Docker engine pipe is unavailable. `GET /ready` returns 200 because readiness currently checks PostgreSQL only. The 15-second REST refresh and offline command replay passed, but do not count as proof of Redis push delivery. The API login and public API rate limiters are process-local, so a multi-instance deployment needs shared rate-limit storage. Restaurant-device acceptance, browser storage eviction behavior, TLS, backup/restore, load and accessibility audits remain outstanding.

## Next highest-priority pilot milestone

Operational readiness on restaurant hardware: provision shared Redis and shared API rate-limit storage, add manager-facing device/session administration and health visibility, then run TLS deployment, backup/restore and device revocation/reconnect drills. Keep payment-provider integration disabled until its own authorization and reconciliation evidence exists.

## Milestone 7 — pilot readiness and production hardening: IMPLEMENTED; VERIFICATION BLOCKED/MIXED (2026-10-22)

Implemented in this change:

- API public/auth request limiting now uses a shared Redis Lua fixed-window counter, SHA-256 client-key digest, configurable per-path limits, explicit trusted proxy CIDRs and fail-closed HTTP 503 on Redis failure. `/ready` checks PostgreSQL plus Redis PING. Request logs redact QR, order-tracking and invitation path credentials; write request bodies and cookies are not logged. API bind host is configurable.
- Kitchen device records can be assigned to a same-store active station. Owner/manager routes provide device list, session-expiration view, activity history, station assignment and revocation; KDS requests/sockets carry the device identifier, restrict station-scoped reads and revalidate revocation/assignment. IndexedDB continues to store no bearer session token.
- Owner/manager employee invitations store only a digest of a random one-time token, expire after 24 hours, audit create/revoke/accept and assign a permitted store role on acceptance. Existing accounts must prove their current password. The admin page, pilot counts/checklist and invite acceptance page are bilingual.
- PowerShell PostgreSQL backup and isolated restore-verification scripts, plus deployment/security/recovery/checklist docs, are added. The restore script verifies SHA-256, refuses existing targets, restores only to a newly named isolated DB and retains that DB for review.

Executed verification on the existing preserved local development data:

| Check | Result |
|---|---|
| Prisma schema validation and client generation | PASS |
| Additive migration `202610270001_pilot_readiness` | PASS; deployed to local `omnihub`, no data reset; 13 migrations up to date |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd test` | PASS; 16 unit tests, including shared-limiter behavior and fail-closed response |
| `pnpm.cmd test:integration` | PASS; 27 PostgreSQL tests, including invitation acceptance, station assignment persistence, prior stock/payment concurrency and POS→Kitchen→Inventory→Payment regressions |
| `pnpm.cmd build` | PASS; final Contracts/API/Next production build completed after runtime/logging changes |
| `pnpm.cmd test:redis` | BLOCKED: `REDIS_UNAVAILABLE`; no Redis listener at localhost:6379, so two independent real clients cannot connect |
| Playwright pilot invitation/device workflow | BLOCKED: attempted; login is rejected with 503 by the required fail-closed limiter while Redis is unavailable |
| Two-browser Redis Socket.IO delivery/reconnect | BLOCKED: attempted; kitchen browser cannot authenticate because Redis limiter is unavailable; previous realtime delivery assertion also missed the push window. REST fallback is not counted as realtime |
| Backup/isolated restore | IMPLEMENTED BUT UNVERIFIED; PowerShell syntax/query parsing checked, but `pg_dump`, `pg_restore` and `psql` are absent from this host, so no real backup or recovery duration was recorded |
| Production TLS/proxy/DB+Redis ACL/target device checks | IMPLEMENTED CONFIGURATION GUIDANCE BUT UNVERIFIED on pilot infrastructure |

Infrastructure blocker: Docker CLI exists, but Docker Engine is unavailable. `com.docker.service` is stopped/manual; its start returned “Cannot open com.docker.service service on computer '.'”, and the Docker Desktop Linux engine pipe is missing. Redis TCP 6379 is unreachable. No Docker container or volume was changed. The existing embedded PostgreSQL data directory was started without reinitialization; PostgreSQL reported an interrupted shutdown, completed automatic WAL recovery and became ready. Migration and integration checks passed against it, then PostgreSQL was gracefully stopped. Data and all prior records were retained. API runtime probe returned `/health` 200, `/ready` 503 and `/auth/login` 503 with Redis absent; this verifies intended fail-closed readiness/limiter behavior, not Redis recovery.

Failure-drill observations: the offline/online browser queue, refresh recovery, duplicate replay and concurrency checks have passing evidence in Milestone 6 and the 27-test database suite. A fresh device-revocation browser flow is blocked before authentication by Redis, though station scope/invitation service data tests passed. API restart during an active kitchen operation and worker restart during outbox processing were not simulated. PostgreSQL automatic WAL recovery after an earlier stopped process was observed at startup, but it was not a planned interruption drill. Redis outage recovery and actual Socket.IO reconnect remain unverified.

The required runbooks and requirement-by-requirement classification are in [deployment](DEPLOYMENT.md), [security](SECURITY.md), [backup/recovery](BACKUP_AND_RECOVERY.md) and [pilot checklist](PILOT_READINESS_CHECKLIST.md). This milestone does not justify a pilot go-live: Redis-backed ingress, actual Socket.IO delivery, a real isolated restore, the complete new Playwright path and target infrastructure security remain open. Do not count blocked tests as passed.

## Recommended next milestone

Controlled pilot environment provisioning and evidence collection: restore Docker/Redis access or provision an authorized managed Redis, pass the real two-client realtime and shared-counter tests, run the invitation/device/revocation Playwright path, complete a backup restore into its separate verification database, and exercise TLS/proxy, Redis outage, API/worker restart and device offboarding on the restaurant's actual deployment. Keep card acquiring and public production traffic disabled until those gates pass.

## Earlier blocked infrastructure attempt — 2026-10-22

This section supersedes any older environment-specific Docker/Redis diagnosis above. The current execution environment is a restricted `ADMIN\CodexSandboxUsers` account, not a Windows administrator.

| Requirement | Status | Evidence from this run |
|---|---|---|
| Docker Desktop installation | VERIFIED | Docker CLI 29.1.2 is installed at `C:\Program Files\Docker\Docker\resources\bin\docker.exe`. |
| Docker Engine/service recovery | BLOCKED | `com.docker.service` exists, is `STOPPED` (demand start, LocalSystem); starting it returned access denied. `docker info` against `npipe:////./pipe/docker_engine` returned permission denied. The current account cannot read the normal Docker config or access the named pipe. No containers or volumes were changed. |
| WSL2 status | BLOCKED | WSL 3.0.3 and kernel 6.1.18 are installed; `WslService` is running, while `LxssManager` is stopped/manual. `wsl --status` and distro enumeration return `WSL/EnumerateDistros/Service/E_ACCESSDENIED`. No distro was changed or unregistered. |
| Redis runtime / real connectivity | BLOCKED | No local Redis/Memurai executable was found; `127.0.0.1:6379` is unreachable. No test was connected to an unknown or production Redis. |
| Shared rate limiting, Redis-backed Socket.IO, kitchen push, device authorization/revocation/reconnect | BLOCKED | Latest `pnpm.cmd test:redis` exited 1 with `REDIS_UNAVAILABLE` before PING. Focused Playwright flows remain blocked before feature assertions by the required fail-closed Redis dependency. REST polling is not counted as realtime evidence. |
| Fail-closed API behavior | VERIFIED | Previously executed API probe: `/health` 200; `/ready` and `/auth/login` 503 while Redis is absent. Security policy was not weakened. |
| PostgreSQL regression and migration state | VERIFIED | Started the existing `.local/postgres` cluster without initialization/reset; `prisma migrate status` reports all 13 migrations up to date; `pnpm.cmd test:integration` passed 27/27. Gracefully stopped PostgreSQL afterward. Existing development records were preserved. |
| Lint, typecheck, unit tests, production build | VERIFIED | This run: lint pass, typecheck pass, unit tests 16/16, Contracts/API/Next build pass. |
| Backup file, isolated restore, integrity/count checks and restore duration | BLOCKED | Host search found no `pg_dump`, `pg_restore` or `psql`; Docker/WSL tooling access is blocked. No backup or restore was claimed or attempted against the source database. |
| Required blocked Playwright cases | BLOCKED | Realtime, invitation/device and revocation flows cannot authenticate while Redis is unavailable. Earlier attempts stopped at the login 503; no feature assertions passed. |
| Pilot readiness | BLOCKED / NO-GO | Shared Redis/realtime verification and a real isolated backup/restore remain critical unverified gates. |

### Manual Windows recovery required

An administrator at the machine must launch Docker Desktop and start the existing `com.docker.service` from an elevated PowerShell session (for example, `Start-Service com.docker.service`), then verify `docker info` and `wsl --list --verbose`. If the engine still returns pipe access denied, grant the intended Windows account the authorized Docker Desktop/`docker-users` access and sign out/in as required. Do not reset Docker Desktop, prune volumes, unregister distributions or reinstall. Once `docker info` succeeds, inspect existing containers/volumes before starting only the repository Redis service. This execution did not have the Windows rights needed to perform that recovery.
