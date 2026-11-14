# Testing strategy

## DR continuation — 2026-10-26

| Check | Status | Current result |
|---|---|---|
| Docker and backup health | VERIFIED | One safe `docker desktop start` restored Engine 29.1.2. Only backup services were updated; new snapshot `3ebfe1b6` verified and backup health passed. |
| Shell and disposable DR tests | VERIFIED | Image build and `sh -n` passed. Network-disabled read-only-source fixtures passed real offsite copy, valid monitor restore, stale/missing remote/primary checks, and pointer immutability on 901-s stale source or unavailable destination. A newest 80-byte invalid archive failed both monitor check and verify. |
| Alert destination gates | VERIFIED | Unapproved URL and HTTP rejected. Real recipient delivery remains BLOCKED. |
| Current isolated restore | VERIFIED | New retained `omnihub_staging_restore_1793012409724_59d46066`: 37 tables, 13 migrations, zero critical errors; API/login/catalog/store/tenant PASS; local service recovery 39.285 s. |
| Lint/typecheck/unit | VERIFIED | Lint and typecheck exit 0. Sandbox Vitest worker spawn failed with `EPERM` before any test ran; authorized rerun passed 27/27. |
| Off-machine DR and site failover | BLOCKED | No independent destination/monitor or physical site drill. The latest observed point age was 212,374 s, failing pilot RPO. |

Prior Playwright 9/9 and PostgreSQL/Redis integration results were not rerun because shared application behavior was unchanged.

## Disaster recovery continuation — 2026-10-24

| Check | Status | Current result |
|---|---|---|
| Updated backup image build and service start | VERIFIED | `docker compose -f deploy/compose.staging.yml --profile backup build backup` and `up -d --no-deps --wait backup backup-monitor`; only backup services were recreated, with original named volumes retained. New manifest-bearing backup `2e983596` verified. |
| Fresh isolated recovery drill | VERIFIED | `pnpm.cmd exec tsx scripts/verify-staging-backup.ts` restored into retained `omnihub_staging_restore_1792798366650_5ebbf990`; 37 tables, 13 migrations, zero critical relationship errors; ready/login/catalog/store/tenant probes passed. Restore 2.030 s; local service recovery 17.259 s. |
| Disposable separate-repository monitor probes | VERIFIED | A network-disabled, read-only-root container read staging backup volumes read-only, copied a current snapshot into tmpfs Restic and passed full decrypt/restore plus stale-point, missing-primary, unavailable-repository and stale-restore negative checks. `DISPOSABLE_MONITOR_PROBES_PASSED`. |
| Real host loss, external copy/monitor/alert and site recovery | BLOCKED | No approved independent storage, monitoring host or recipient. No real off-machine transfer, alert delivery or site failover executed. The prior outage remains a failed 15-minute RPO observation. |
| Application-wide regression | UNVERIFIED | Shared application code was unchanged, so the complete suite was not repeated in this continuation. The previous 9/9 Playwright, 27/27 unit, 27/27 PostgreSQL and 2/2 Redis remain historical evidence. |

All disposable copies stayed in container tmpfs. The new restore database and all prior backups/volumes remain retained. See [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) for RPO semantics and the off-machine design.

Final targeted rerun after alert-tooling changes: backup image build PASS; `sh -n` on backup/offsite/monitor/alert scripts PASS; offline notification allowlist and TLS rejection PASS; unapproved offsite command rejected with exit 2; disposable monitor full restore and stale-point (901 s), missing-primary, unavailable-repository and stale-restore negative probes PASS. The final running backup image produced `d6f1118a`, and `pnpm.cmd exec tsx scripts/verify-staging-backup.ts` restored it into new retained `omnihub_staging_restore_1792798675143_22675dc8`: 37 tables, 13 migrations, zero relationship/integrity defects, API readiness/login/catalog/store/tenant PASS, 32.209-s local service recovery. During this continuation `pnpm.cmd lint`, `pnpm.cmd typecheck`, and `pnpm.cmd test` exited 0 (27/27 unit). No application code changed, so PostgreSQL/Redis integration and full Playwright were not rerun; their prior pass counts remain historical.

After the final fail-closed alert-config change, the image was rebuilt, shell syntax and disposable monitor probes passed again, and backup services were safely restarted. New snapshot `04ed880f` passed backup health and restored to third unique retained DB `omnihub_staging_restore_1792798881847_952394ed` with 37 tables, 13 migrations, zero critical defects, application/auth/isolation probes PASS, and **25.839 s** local service recovery. This is the current final-image restore evidence.

One further disposable test inserted a checksum-consistent but 80-byte invalid PostgreSQL archive into the tmpfs remote repository. `omnihub-dr-monitor verify` exited nonzero and emitted `REMOTE_ARCHIVE_INVALID`; `DISPOSABLE_MONITOR_PROBES_PASSED`. No staging repository artifact was altered.

## Final backup/DR verification — 2026-10-24 local time

Docker access: ordinary `docker info` exited 1 with `permission denied` on `npipe:////./pipe/docker_engine`; elevated `docker info --format '{{.ServerVersion}} {{.Name}}'` returned `29.1.2 docker-desktop`. Existing staging containers, networks, database and volumes were reused. Only the web container was updated to run the corrected POS image. This section supersedes the earlier Docker-blocked status below.

| Executed check | Status | Result |
|---|---|---|
| `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build` after POS fix | VERIFIED | All exited 0; optimized Next.js build completed. |
| `pnpm.cmd test` | VERIFIED | 27/27 unit tests in 3 files passed after final code changes. |
| PostgreSQL integration in staging network | VERIFIED | `docker compose -f deploy/compose.staging.yml --profile tools run --no-deps -e NODE_ENV=test -e SESSION_SECURE=false seed node --require /app/deploy/load-secrets.cjs node_modules/vitest/vitest.mjs run tests/integration`: 27/27 passed, including transactional stock/payment/QR paths. Unique test fixtures were added; no database was reset. |
| Redis integration in staging network | VERIFIED | Same one-off command with `tests/redis`: 2/2 passed, including cross-process HTTP rate limiting. First run failed because test fixtures used a disallowed key and `DEL`; fixtures now use the permitted rate-key namespace and 60-s TTL. Production Redis ACL was unchanged. |
| Updated isolated recovery verifier | VERIFIED | `pnpm.cmd exec tsx scripts/verify-staging-backup.ts` passed: exact-snapshot decryption, checksum, archive, 37-table schema names, 13 migrations, zero broken relationships, API ready, fixture login, tenant/store isolation. New retained DB `omnihub_staging_restore_1792796154670_d5977108`; recovery 25.666 s. Evidence `.local/staging/recovery-omnihub_staging_restore_1792796154670_d5977108.json`. |
| 20-minute backup schedule observation | VERIFIED | Five valid scheduled snapshots spanning 1,200 s with four 300-s gaps, plus observed stale and dump-failure alerts after host restart. Evidence `.local/staging/backup-schedule-observation-20min-20261024.json`; the earlier 15-minute report is retained. This does not demonstrate uninterrupted RPO compliance. |
| Full HTTPS Playwright after final web fix | VERIFIED | First run **8/9** exposed stale POS modifier state. Fixed product selection to fetch the current API catalog; focused test passed 1/1. Final complete run **9/9 in 1.7m** using `E2E_WEB_ORIGIN=https://localhost:8443`, `API_BASE_URL=https://localhost:8444`, strict local CA and current SPKI `WQpNc0XwlfIi95zf2FiqbaBBLkaid7jkSQAxLoEkInA=`. Artifact `.local/staging/e2e-full-final-20261024`. Includes real Socket.IO, offline KDS, QR, cash shifts, POS, catalog and device revocation. |
| Final HTTPS/service health | VERIFIED | Strict-CA Node fetch: web 200 and API `/ready` 200; PostgreSQL, Redis, API, web and worker healthy; Redis PONG and backup health exit 0. |
| 15-minute RPO during host outage | FAILED | Restart exposed a 35,797-s-old recovery point and local stale alert. |
| Offsite recovery, delivered paging and physical UAT | BLOCKED | There is no approved off-machine repository, operator alert endpoint or restaurant hardware acceptance. Pilot remains NO-GO. |

The final browser suite exercised web image `sha256:3d0d851e66be10f5f08e344dec8743cc6ee3e76f852b340a729d701855d4ec4c` and existing API image `sha256:e6914c85f5360363fb65fb53c6ecdcba046fccc2408ff8a02dac2ea13baf967d`. The rebuilt API image used for one-off Redis tests only changes test fixtures; no API business logic changed. Historical runs below remain historical evidence.

## Prior blocked continuation evidence — superseded by final verification above

| Check | Status | Observed evidence and limit |
|---|---|---|
| `pnpm.cmd lint` | VERIFIED | Exit 0 after backup/recovery changes. |
| `pnpm.cmd typecheck` | VERIFIED | Exit 0 after explicit relationship assertions were added. |
| `pnpm.cmd test` | VERIFIED | 3 files, 27/27 unit tests passed. |
| `pnpm.cmd build` | VERIFIED | Exit 0; contracts/API TypeScript and Next.js optimized production build completed. This is a local build, not a rebuilt Docker staging image. |
| Backup fault probes (2026-10-23 UTC) | VERIFIED | Invalid host -> `PG_DUMP_FAILED`/exit 1; fake 80-byte dump -> `BACKUP_TRUNCATED`/exit 1; lock contention -> `BACKUP_OVERLAP`/exit 75; old state -> `BACKUP_STALE`. Verified pointer unchanged on failed attempts. Two valid scheduled recovery points were 300 seconds apart. |
| Isolated backup restore (2026-10-23 UTC) | VERIFIED, scoped | New DB `omnihub_staging_restore_1792759892602_1630e3b4`; 37 tables, 13 migrations, owner login and store/tenant isolation; local service recovery 14.564 seconds. Explicit orphan assertions added afterward have not run. |
| PostgreSQL/Redis integration and full HTTPS Playwright after final changes | BLOCKED | Docker Desktop Engine pipe absent; Desktop reports unable to start, WSL enumeration `E_ACCESSDENIED`, stopped `com.docker.service` cannot be opened by `Start-Service`. Previous staging Playwright 9/9 twice is historical only. Do not mark the new run passed. |
| Off-machine copy and physical-device UAT | BLOCKED | No approved destination/credentials or restaurant hardware. |

Once Docker/WSL access is restored by an authorized Windows administrator, run `docker info`, `docker compose -f deploy/compose.staging.yml --profile backup ps`, a fresh `pnpm exec tsx scripts/verify-staging-backup.ts`, PostgreSQL/Redis integration, then the full `pnpm exec playwright test` against the exact HTTPS staging build. Preserve existing databases, volumes and previous test artifacts; use a new E2E output directory. See [PILOT_UAT.md](PILOT_UAT.md) for bilingual physical acceptance.

## Final isolated-staging verification — 2026-10-23 11:45 UTC

All commands below ran from this workspace against the retained local `omnihub-staging` Compose project; no public deployment, volume reset or source-database restore occurred. Docker Desktop was initially stopped, then safely started; Docker Engine 29.1.2 and all existing services recovered. This copy has no `.git`, so an uncommitted-change diff could not be captured.

| Check | Status | Executed result / limitation |
|---|---|---|
| `docker compose -f deploy/compose.staging.yml build api web` | VERIFIED | Final API image `sha256:e6914c85f5360363fb65fb53c6ecdcba046fccc2408ff8a02dac2ea13baf967d`; web `sha256:c40d34d09c19dd3e08ae8388f7bd23a435df47abe55ef58b9d843f7b7c490a1a`. API/worker/web were recreated from these images; database/Redis/backup volumes were retained. |
| `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd test` | VERIFIED | Exit 0; unit tests **27/27** in 3 files after the backup-script fix. |
| Full HTTPS Playwright before and after backup fix | VERIFIED | First full run **9/9 in 2.0m**, artifact `.local/staging/e2e-final-verification-20261023`; final full run **9/9 in 1.4m**, artifact `.local/staging/e2e-post-backup-fix-20261023`. Both used `E2E_WEB_ORIGIN=https://localhost:8443`, `API_BASE_URL=https://localhost:8444`, retained local CA in `NODE_EXTRA_CA_CERTS`, exact Caddy SPKI and the real seeded login secret. Tests include POS/payment/refund, cash shifts, live Socket.IO, offline replay/conflict, CORS, catalog, mobile QR and device revocation. |
| PostgreSQL and Redis integration suites | VERIFIED (earlier staging run) | Prior isolated staging execution reported **27/27 PostgreSQL** and **2/2 Redis** tests. They were not rerun in this final pass; current Redis PING and browser Socket.IO delivery were rechecked. |
| TLS, CORS and dependency health | VERIFIED | `pnpm exec tsx scripts/staging-tls-trust.ts`: both 8443/8444 trusted by local CA, SPKI `2Y1Gpo3iH9icj1QlITEyMd0KAYJVx7W+oyrb/I6afuk=`. Strict-CA Node fetch: API `/ready` 200; web 200; evil Origin 403; allowed Origin 200; HSTS present; HTTP 8080 redirect 308. An actual HTTPS owner login returned 201 with Secure/HttpOnly/SameSite=Strict cookie flags (cookie value not printed). Redis `PING` = PONG; all Compose healthchecks healthy. Earlier staging drill verified proxy policy, API/Redis/worker/PG restart recovery and log redaction; drill report `.local/staging/drill-evidence.json`. |
| Retained restore read-only | VERIFIED with scope limit | Existing restore `omnihub_staging_restore_1792752599405_da0989d0`: 37 tables, 13 completed migrations (13 repository migration directories), 0 unvalidated constraints; 1 store, 4 users, 3 products, 4 memberships, 5 recipe lines, 3 balances, 0 orders/payments/shifts. Orphan membership/recipe/balance and invalid-balance checks all returned 0. Initial app SELECT failed because `--no-acl` restore omitted grants. A SELECT-only grant on this restore permitted app-role Prisma reads. Isolated API GET `/health`/`/ready` returned 200; anonymous `/admin/products` and `/auth/me` returned 401; ACL metadata showed SELECT=true/INSERT=false. A valid login and tenant-isolation business endpoint could not be exercised without writes or multi-store snapshot data. |
| Backup failure probe and repaired snapshot | VERIFIED | `docker compose ... run --no-deps -e PGHOST=invalid-backup-target backup once` exited 1; no success marker. Rebuilt backup image, restarted only backup service. New Restic snapshot `31ce207a` (265,351 bytes) passed `restic check --quiet` and `restic dump 31ce207a /database.dump | pg_restore --list`. A later check met one stale shared lock: its PID 184 was absent from the same container; standard `restic unlock` removed exactly that lock, then `restic check --quiet` returned 0. Prior `6ddbb752` is invalid (80 bytes) and retained for incident review. |
| Target RPO, off-host restore, physical restaurant acceptance | FAILED / BLOCKED | Valid backups were 19 minutes apart across an outage, failing the 15-minute target. No off-machine copy, real restaurant devices, target DNS/TLS or staff acceptance evidence exists. Pilot remains NO-GO. |

The restored probe's `PGOPTIONS=-c default_transaction_read_only=on` did **not** take effect through Prisma (`SHOW default_transaction_read_only` returned `off`), so read-only safety was enforced by the scoped SELECT-only database grant and by issuing only SELECT/GET calls. Do not interpret `/ready` alone as proof that app tables are readable. Windows Schannel `curl --cacert` returned a local-CA revocation-status error; strict Node TLS verification succeeded and was used for the HTTP assertions. Actual test results and limitations take precedence over historical entries below.

Run commands from repository root with Node 22.14+ and pnpm 12.4.1. PowerShell may require pnpm.cmd rather than pnpm.ps1; no execution policy change is needed.

## Latest executed evidence — 2026-10-23

The local Redis/realtime/restore blockers in older sections below are resolved. Docker Engine is accessible through authorized execution outside the Codex sandbox. Redis uses the retained `omnihub_redis_data` volume and returns PONG; API `/ready` returns 200 with both dependencies healthy. The preserved embedded PostgreSQL cluster supplies the database; no reset or seed was run.

| Check | Status | Result |
|---|---|---|
| Lint and typecheck after final test changes | VERIFIED | Both pass. |
| Unit tests / PostgreSQL integration / production build | VERIFIED | Final application implementation passed 16/16 unit tests, 27/27 PostgreSQL tests and Contracts/API/Next build during the October 22–23 milestone. |
| Real Redis tests | VERIFIED | 2/2 pass, including actual HTTP requests across separate API processes. |
| Focused realtime and pilot/device Playwright | VERIFIED | 2/2 pass, followed by the full suite. |
| Final full Playwright | VERIFIED | 9/9 pass in 1.3m; output `.local/infra-recovery/resume-20261023/e2e-verified`. |
| Real backup/isolated restore | VERIFIED | 37 table counts/schema/13 completed migrations match; six integrity checks report zero violations. Backup and restored counts rechecked after interruption. |
| Target pilot TLS/security/load/operator drills | BLOCKED | No deployed restaurant environment supplied; these are not implied by local regression results. |

The browser run uses API port 4001, `API_BASE_URL=http://localhost:4001`, a web build with `NEXT_PUBLIC_API_URL=http://localhost:4001` and local-only `AUTH_LOGIN_RATE_LIMIT=100`. The normal limit remains 10/minute. API, worker, web, Redis and PostgreSQL must all be running. Run the complete suite with `pnpm.cmd exec playwright test --output=.local/<new-evidence-directory>`; use a fresh evidence directory to preserve previous traces.

Final runtime probe: `/health` 200, `/ready` 200, and zero undelivered outbox records. The local verification stack was left running (web 3000, API 4001, worker, preserved PostgreSQL and Redis); process IDs for the app services are recorded in ignored `.local/infra-recovery/resume-20261023/processes.json`. The temporary 100/minute login setting belongs to this test API process, not the normal default.

Realtime evidence is actual Socket.IO frames in both browser contexts, with a new authenticated handshake after transport interruption and subsequent events. Offline emulation alone left an existing socket open, so the test now closes a real forwarding transport. Device tests verify missing-device rejection, station reassignment/reconnect, revoked HTTP access and replay, socket closure, rejection of a fresh revoked-device handshake, no order change from denied replay, and audit history. Invitation acceptance uses the real public API; the acceptance page is not independently covered by that workflow.

Failure evidence was retained. Initial runs exposed the KDS registration/socket race and disconnected indicator, plus a missing device header and ambiguous administration selectors in the tests. A later cashier HTTP refresh took 5.93s after the already-observed frame; its rendering timeout is now separate from the five-second push assertion. QR setup waits for loaded configuration before inspecting its controlled checkbox. The final complete suite passed after these fixes; no polling-only result was called realtime success. Desktop/mobile/tablet layout assertions, POS/payment/refund/cash, catalog, QR and both offline KDS scenarios are included.

## Commands and coverage

- pnpm db:generate: generated Prisma client.
- pnpm typecheck: all workspace strict TypeScript checks.
- pnpm lint: ESLint TypeScript checks including unused variables and explicit-any prohibition.
- pnpm test: pure domain math/state/permission, recipe unit conversion/composition and price calculation tests.
- pnpm test:integration: real PostgreSQL catalog/recipe/receipt writes plus transactional workflow, concurrency, tenant isolation and ledger reconciliation. Requires DATABASE_URL and isolated fixture IDs; never point at production. Tests create unique tenant fixtures, no database truncation.
- pnpm test:redis: independent Redis clients atomically increment unique test keys and verify TTLs. A second test starts two real built API processes on temporary loopback ports and checks their shared HTTP login limit (400, 400, then 429). It requires real Redis, PostgreSQL and a built API. Test processes are stopped and only the generated Redis test keys are removed.
- QR integration cases exercise token hash/rotation, scoped menu availability, separate tracking access, idempotent order acceptance, one-ticket/one-reservation behavior, revocation and simultaneous last-stock attempts.
- pnpm test:e2e: browser POS -> kitchen -> payment -> report, owner catalog/table workflows, and customer QR menu/order/tracking on a 390px viewport; requires running web/API, PostgreSQL, migrated schema and seeded local fixture credentials via environment.
- Offline kitchen browser workflows: cached ticket reload, durable ordered START/READY queue across reload, duplicate replay reconciliation, stale-server conflict and dependent-command review, plus 390px/820px layout checks. Test API URLs can be overridden with `API_BASE_URL`; this lets tests target an isolated local API without disturbing another service on port 4000.
- Realtime browser test also requires Redis and `pnpm worker`; it observes actual Socket.IO frames in separate cashier/kitchen browsers, proves order acceptance and preparation events, interrupts a real proxied WebSocket, and requires a new authenticated handshake plus delivery after reconnect. The proxy forwards real traffic unchanged. Frame delivery and kitchen ticket visibility must complete within five seconds after acceptance; a REST polling update alone cannot pass. Cashier rendering is checked separately with a ten-second HTTP-read allowance. Admin browser tests check mobile and tablet viewport overflow.
- pnpm build: contracts, API, web production compilation.
- `scripts/backup-postgres.ps1` and `scripts/verify-postgres-restore.ps1` support native PostgreSQL tools. `scripts/verify-container-backup.ts` supports an existing isolated PostgreSQL 18 tooling container: custom archive/readability/checksum, a new restore DB, all table counts, schema metadata, migration state and stock/financial integrity checks. The container drill retains all databases and local backup artifacts and performs no retention deletion. See BACKUP_AND_RECOVERY.md for actual drill evidence.

QR E2E downloads and prints the generated SVG and submits a real test order, so it adds rows and reservations to the development database. The Redis realtime kitchen E2E is only considered verified when another kitchen browser receives the outbox event before polling; a polling update is not a passing realtime assertion.

Required coverage is specified in lifecycle documents. Evidence and limits are recorded in IMPLEMENTATION_STATUS.md; a test definition is not a passing execution. PostgreSQL/Redis absence does not justify a fake database replacing concurrency tests. Performance, accessibility audits, full fault injection and actual backup restore are pilot gates not covered by a compile check.

Local tests leave isolated fixture tenants and explicit demo transactions for auditability. Re-running browser tests adds sales/reservations to demo data. Reports assert coherent totals, not an assumed empty database. The append-only ledger intentionally disallows ad hoc cleanup. Use a separately named development database for a fresh environment rather than truncating existing data.

CI workflow prepares PostgreSQL 17/Redis and runs generate/migrate/lint/typecheck/unit/integration/build. Hosted CI execution and automated browser startup in CI remain unverified. Local checks passed on both PostgreSQL 18 optional developer binary and a separate PostgreSQL 17 Docker instance.

## Latest QR milestone evidence (2026-10-22)

Passed locally: lint, typecheck, 13 unit tests, 24 PostgreSQL integration tests, production build, migration status (11 migrations up to date), and 5 Playwright workflows when excluding the Redis-only realtime case. The browser workflows cover the POS→Kitchen→Payment→Report regression, cash shifts, origin/anonymous validation, real catalog/table administration and mobile QR order/tracking. The QR browser test writes order data to the persistent development database.

The kitchen realtime browser assertion was attempted, but Redis could not be started in this environment and outbox delivery did not reach the second kitchen browser within the pre-poll assertion window. Record it as **unverified**, not passed. Run `pnpm.cmd exec playwright test tests/e2e/workflow.spec.ts -g realtime` with Redis and the API worker running to verify that path. REST status refresh is not a substitute for this assertion.

## Offline kitchen evidence (2026-10-22)

Passed after rebuilding against an isolated local API: 7/7 Playwright workflows excluding only the Redis-dependent realtime test. This includes the POS→Kitchen→Cash/report regression, matching and discrepancy cash-shift flow, offline queue persistence/replay and duplicate-safe reconciliation, a competing online update that blocks dependent offline commands, HTTP origin/anonymous validation, real catalog administration, and mobile QR ordering/tracking. The tests ran against the preserved local PostgreSQL database and added development orders/transactions; no rows were deleted. `pnpm.cmd lint`, `pnpm.cmd typecheck`, 14 unit tests, 26 PostgreSQL integration tests and production build also passed.

To isolate browser tests from an unrelated process on port 4000, the local API was run on port 4001 with `AUTH_LOGIN_RATE_LIMIT=100`, the web build used `NEXT_PUBLIC_API_URL=http://localhost:4001`, and Playwright used `API_BASE_URL=http://localhost:4001`. The API login limit defaults to 10 requests per minute and is capped at 100. The elevated value is for local test runs only; retain the default for normal operation. The current rate limiter is process-local and needs a shared store for multi-instance deployment.

The Redis realtime E2E is not counted as passed. Redis port 6379 is unreachable and the Docker service/engine is unavailable on this host; a second kitchen client did not receive the outbox event before the five-second assertion window. REST polling passed separately and does not prove push delivery.

## Pilot hardening evidence (2026-10-22)

Passed: `pnpm.cmd lint`, `pnpm.cmd typecheck`, `pnpm.cmd build`, 16 unit tests, 27 real PostgreSQL integration tests and migration status with 13/13 migrations applied. PostgreSQL was started from the existing `.local/postgres` data directory without initialization/reset and gracefully stopped after verification. The DB suite writes unique fixture tenants and an invitation user; it deletes no pre-existing data.

Blocked, not passed: `pnpm.cmd test:redis` reports `REDIS_UNAVAILABLE` because localhost:6379 refuses connections. API smoke checks returned `/health` 200, `/ready` 503 and `/auth/login` 503, confirming fail-closed behavior. The focused realtime E2E and new invitation/device E2E were attempted against the built web and API; both stopped at login because Redis-backed authentication limiting was unavailable. No feature assertion was reached. The unverified realtime path must still be run with a real Redis service and worker.

The backup and restore scripts parsed successfully, but actual backup/restore was not run: the host has no `pg_dump`, `pg_restore` or `psql` client executable. Do not treat PowerShell syntax validation or PostgreSQL's observed startup WAL recovery as a restore/failure-drill pass.

## Earlier blocked infrastructure attempt (2026-10-22)

Current Docker diagnosis: Docker CLI 29.1.2 is installed, but `com.docker.service` is stopped (demand start), Docker Engine named-pipe access is denied, and this sandbox account cannot start the service. WSL is installed and its service is running, but `wsl --status`/distro enumeration return `E_ACCESSDENIED`. No Docker state, volume or WSL distribution was changed. Redis/Memurai and PostgreSQL client binaries (`pg_dump`, `pg_restore`, `psql`) were not found in the host or repository tooling paths. Port 4000 was occupied by an unknown listener and was left untouched.

Rerun against the existing embedded PostgreSQL cluster: lint PASS; typecheck PASS; unit tests 16/16 PASS; PostgreSQL integration tests 27/27 PASS; production build PASS; Prisma migration status PASS (13 migrations up to date). PostgreSQL was started from the existing data directory without initialization, then gracefully stopped. No development data was deleted. A first `prisma migrate status` invocation hit the sandbox's inaccessible default temp path; rerunning with repository-local `.tmp` for `TEMP`/`TMP` succeeded.

The latest `pnpm.cmd test:redis` attempt exited 1 with `REDIS_UNAVAILABLE` before Redis PING, because the configured real Redis endpoint could not be reached. Classify this as BLOCKED by infrastructure, not as an application assertion failure. Two-instance shared limiter, Socket.IO kitchen delivery/reconnection, device/revocation Playwright, and isolated backup/restore remain BLOCKED. Do not interpret previous Redis-dependent browser attempts as feature passes: authentication returned the designed 503 before their feature assertions. REST polling is not realtime verification. Do not use Redis mocks or an unverified external Redis endpoint to convert these into passes.
