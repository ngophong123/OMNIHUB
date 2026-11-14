# Controlled restaurant pilot readiness

## DR continuation decision — 2026-10-26

**NO-GO.** The latest host restart exposed another RPO breach: `BACKUP_STALE` at 2026-10-26 10:55:08 UTC reported a **212,374-second-old** verified point. Actual transaction loss is unknown. No independent copy or alert exists.

| Critical requirement | Status | Evidence / next action |
|---|---|---|
| 15-minute RPO across host downtime | FAILED | 212,374 s exceeds 900 s; independently verify recovery points through a controlled outage. |
| Remote snapshot readability before RPO credit | VERIFIED | Updated `check` fully decrypts/checks the newest point every run. Both `check` and `verify` rejected an 80-byte invalid tmpfs archive. This proves tooling only. |
| Offsite copy gates | VERIFIED | Actual copy path passed between two encrypted tmpfs repositories. Stale source (901 s) and unavailable remote did not advance the fixture pointer. |
| Local isolated recovery | VERIFIED | Snapshot `3ebfe1b6` restored into retained `omnihub_staging_restore_1793012409724_59d46066`; 37 tables, 13 migrations, zero critical errors, API/login/catalog/store/tenant checks passed; 39.285-s local service recovery. |
| Actual off-machine copy and alert delivery | BLOCKED | Approved independent storage, monitor host, credentials and recipient are absent; no external upload or delivered notification. |
| Restaurant RTO and physical UAT | UNVERIFIED | Local recovery excludes incident response/cutover; no real devices, peripherals or staff sign-off. |

Backup services are running on the updated image and the repository/volumes were retained. Lint, typecheck and unit 27/27 passed. Earlier Playwright 9/9 and PostgreSQL/Redis integration results were not repeated because application code did not change.

## Disaster recovery hardening decision — 2026-10-24

**NO-GO.** This continuation changed backup tooling and guidance, not shared application behavior. Prior full Playwright 9/9, unit 27/27, PostgreSQL 27/27 and Redis 2/2 remain historical verified results; they were not rerun in this continuation.

| Critical requirement | Status | Evidence / remaining risk and action |
|---|---|---|
| RPO during host outage | FAILED | At restart the newest verified point was 35,797 s old. Five later 300-s gaps validate uptime cadence only. Actual transaction loss and outage start are unknown. Prove independently verified offsite recovery-point age ≤900 s across a controlled site outage. |
| Backup integrity and new manifest | VERIFIED | New snapshot `2e983596` passed dump/archive/checksum/Restic/decrypt/manifest checks before pointer advancement; invalid 80-byte `6ddbb752` remains preserved. |
| Isolated local recovery | VERIFIED | Fresh retained DB `omnihub_staging_restore_1792798366650_5ebbf990`: 37 tables, 13 migrations, zero critical integrity/relationship errors; API ready, login and tenant/store isolation passed. Local recovery 17.259 s. |
| Remote-copy and monitor software | VERIFIED | Disposable, network-disabled container copied a verified snapshot to a separate tmpfs Restic repository and passed monitor success, restore and negative probes for stale remote, missing primary, unavailable repository and stale restore evidence. This verifies tooling only. |
| Actual encrypted off-machine copy/recovery | BLOCKED | No approved separate host/storage or credentials. No sensitive backup was uploaded. Provision an independent repository, prove decrypt/restore and retention there. |
| Independent alert delivery and outage detection | BLOCKED | No approved recipient/monitor host. Local stale alert came only after host restart, at least 34,897 s after threshold crossing. Run the independent monitor under supervision, test delivery and measure alert latency during outage. |
| Pilot-site 15-minute RPO | FAILED | The prior host outage exceeded the maximum recovery-point age. Execute full site-level timed drill and record actual last committed transaction and recoverable point. |
| Pilot-site 60-minute RTO | UNVERIFIED | The 17.259-s local recovery excludes incident response and cutover. Time the full path through usable restaurant service. |
| Physical-device restaurant UAT | UNVERIFIED | Bilingual [pilot UAT plan](PILOT_UAT.md) covers roles, mobile/tablets, kitchen offline, payments, cash, peripherals and fallbacks; no real device/staff run or sign-off. |

WAL archiving/PITR is **NOT IMPLEMENTED** and is not required for the proposed small-pilot five-minute dump design; see [recovery architecture and runbook](BACKUP_AND_RECOVERY.md). The design remains a proposal until an approved independent fault domain exists.

Final local recovery evidence after the alert-tooling build: snapshot `d6f1118a` restored to retained `omnihub_staging_restore_1792798675143_22675dc8`; recovery point age 44 s at start, 37 tables, 13 migrations, zero critical relationship errors, login and tenant/store checks passed, **32.209 s** local service recovery. The disposable monitor probes passed again after the final script change. No restaurant-site RPO/RTO claim follows from this local result.

The exact final backup image subsequently produced `04ed880f` and passed backup health. Its new isolated restore `omnihub_staging_restore_1792798881847_952394ed` passed the same checks with **25.839 s** local service recovery and a 49-s-old point at start. This supersedes the preceding local timing as current evidence; older databases are retained.

The final disposable monitor run additionally rejected an 80-byte invalid archive in its separate tmpfs repository with `REMOTE_ARCHIVE_INVALID`. This proves the verification gate in the fixture, not durability of an actual off-machine copy.

## Final backup/DR verification — 2026-10-24 local time

**Decision: NO-GO for restaurant customers.** Docker Engine 29.1.2 was accessible through an elevated command; the default sandbox was denied access to its Windows named pipe. Existing staging networks, PostgreSQL/Redis data and Restic volumes were retained. The web container alone was replaced with the fixed image `sha256:3d0d851e66be10f5f08e344dec8743cc6ee3e76f852b340a729d701855d4ec4c`; the API/worker kept their existing application image. No public deployment occurred. This section supersedes the earlier Docker-blocked assessment below.

| Critical requirement | Status | Current evidence / remaining action |
|---|---|---|
| Verified encrypted local backup and false-success protection | VERIFIED | Fresh snapshot `24701e94` passed dump/archive, SHA-256, Restic check and exact-snapshot decryption before pointer advancement. Historical invalid 80-byte artifact `6ddbb752` remains preserved. Prior controlled failure/truncation/overlap probes left the pointer unchanged. |
| New isolated restore, schema and application recovery | VERIFIED | Snapshot `24701e94` restored to new retained DB `omnihub_staging_restore_1792796154670_d5977108`: 37 matching public tables, 13 completed migrations, zero invalid balances/unvalidated constraints and zero broken membership, recipe, payment/order or payment/shift relationships. API readiness, owner login, catalog read and tenant/store isolation passed; recovery duration **25.666 s**. Evidence: `.local/staging/recovery-omnihub_staging_restore_1792796154670_d5977108.json`. |
| Backup cadence during a controlled 20-minute uptime window | VERIFIED | Five scheduled verified recovery points at 22:59:10, 23:04:10, 23:09:10, 23:14:10 and 23:19:10 UTC on 2026-10-23; four gaps of 300 s. Backup health exited 0. Evidence: `.local/staging/backup-schedule-observation-20min-20261024.json`; the earlier 15-minute report is retained. This is a bounded observation only. |
| Pilot-wide 15-minute RPO | FAILED | An earlier 19-minute valid-backup gap exceeded the target; after this host was down, the verified point was **35,797 s** old when monitoring resumed. Local monitoring cannot alert while the host is off. Require independently delivered/off-host monitoring and off-machine backup, then sustained pilot-site observation. |
| Local failure/stale detection | VERIFIED | On restart, `backup-monitor` logged `BACKUP_STALE` with age 35,797 s; the first dump logged `PG_DUMP_FAILED` while PostgreSQL was starting. Neither was marked a verified backup. A later valid backup recovered health. |
| Delivered operator alert and encrypted off-machine copy | BLOCKED | Alerts are durable local JSON/log events only. No approved destination, credentials, independent restore or paging channel has been supplied; no backup was uploaded externally. |
| Local 60-minute recovery drill | VERIFIED | The local drill finished in 25.666 s against the proposed 60-minute target. |
| Restaurant-site RTO | UNVERIFIED | Detection, human decisions, site cutover and physical infrastructure were outside the local drill clock. |
| Final automated regression | VERIFIED | Lint, typecheck, production build, 27/27 unit, 27/27 PostgreSQL integration and 2/2 Redis integration passed. Full HTTPS Playwright after the POS catalog-refresh fix passed **9/9 in 1.7m**; strict-CA web and API `/ready` both returned 200. Artifact: `.local/staging/e2e-full-final-20261024`. |
| Physical-device and signed bilingual UAT | BLOCKED | [PILOT_UAT.md](PILOT_UAT.md) is prepared; restaurant staff, mobile/tablet devices, peripherals and interrupted-network acceptance remain untested on site. |

The earlier 8/9 browser run exposed stale POS catalog state after an administrator added a modifier; the targeted rerun passed 1/1 and the complete final run passed 9/9. Do not treat local automated verification as physical or disaster-site acceptance.

## Prior blocked assessment — superseded by final verification above

**Decision: NO-GO.** The latest successful isolated staging drill is from 2026-10-23 UTC; Docker Engine could not be reached in this continuation. `docker desktop start` reported `Docker Desktop is unable to start`, WSL enumeration returned `E_ACCESSDENIED`, and `com.docker.service` was stopped; `Start-Service` could not open it. No databases, snapshots or volumes were reset. An authorized Windows administrator must restore the Docker Desktop service/WSL access and confirm `docker info` before the final regression can run.

| Critical requirement | Status | Evidence / next action |
|---|---|
| Backup validation and false-success prevention | VERIFIED | Local fault probes show the new scheduler rejects failed `pg_dump`, 80-byte/truncated output, overlap and stale verified state; failed probes left the verified pointer unchanged. The historical invalid `6ddbb752` snapshot is preserved. |
| 15-minute RPO sustained | UNVERIFIED | Two valid scheduled recovery points on 2026-10-23 were exactly 300 seconds apart; the earlier 19-minute gap FAILED the target. Monitor alerts locally at age 900 seconds. Continuous uptime and delivered operator alerting still need proof. |
| Encrypted off-machine recoverability | BLOCKED | Allowlisted, separately encrypted Restic copy/verification tooling exists; no approved destination or credentials. Do not upload to an unknown host. |
| Isolated recovery and 60-minute local RTO target | VERIFIED | Local 2026-10-23 drill restored a new database, checked 37 tables/13 migrations and actual login/store isolation; service recovery took 14.564 seconds. The new relationship assertions have not yet run because Docker is inaccessible. Restaurant-site RTO remains UNVERIFIED. |
| Final build and 9-workflow Playwright after these changes | BLOCKED | Previous exact staging build passed 9/9 twice on 2026-10-23; a new full run cannot be claimed until Docker recovers. |
| Physical devices and signed bilingual UAT | BLOCKED | Scenarios and acceptance criteria are in [PILOT_UAT.md](PILOT_UAT.md); no restaurant hardware/staff execution. |

The absence of `.git` here and in checked parent directories prevents a safe source-history comparison. Obtain the authoritative history/remote before considering local-only initialization; do not publish automatically.

## Final isolated-staging review — 2026-10-23 11:42 UTC

**Decision: NO-GO for real customers.** This section supersedes older local-infrastructure summaries below. The exact final application images were `api sha256:e6914c85f5360363fb65fb53c6ecdcba046fccc2408ff8a02dac2ea13baf967d` and `web sha256:c40d34d09c19dd3e08ae8388f7bd23a435df47abe55ef58b9d843f7b7c490a1a`. The first full HTTPS run on these images passed **9/9 in 2.0m**; the final repeat after the backup-code fix passed **9/9 in 1.4m**. No public deployment was made.

| Critical requirement | Status | Evidence, remaining risk and required action |
|---|---|---|
| Final application build and nine browser workflows | VERIFIED | Docker Compose built the API/web images above; complete Playwright passed 9/9 twice across POS, payment/refund, shifts, catalog, QR/mobile, live kitchen, offline replay/conflict and device revocation. Final artifact: `.local/staging/e2e-post-backup-fix-20261023`. |
| Local TLS, proxy, session, CORS and readiness | VERIFIED | Local CA verified both HTTPS ports and SPKI; `/ready` 200, web 200, foreign Origin 403, HTTP redirect 308, HSTS present. Actual HTTPS login returned 201 with Secure/HttpOnly/SameSite=Strict cookie flags. Earlier staging drill verified trusted-proxy path. A local CA is not restaurant/public PKI. |
| Redis, Socket.IO, worker and dependency recovery | VERIFIED | Redis PONG; all Compose services healthy after Docker Desktop restart. Playwright sees actual cross-browser Socket.IO frames; previous staging drills exercised API/Redis/worker/PostgreSQL restarts and duplicate delivery. |
| Local encrypted backup and isolated restore | VERIFIED | Restic snapshot `37bd278b` restored to retained `omnihub_staging_restore_1792752599405_da0989d0`: 37 tables and 13 completed migrations. Read-only counts: 1 store, 4 users, 3 products, 4 memberships, 5 recipe lines, 3 balances; 0 orders/payments/shifts. Orphan membership/recipe/balance and invalid-balance checks all returned 0. After a **SELECT-only grant scoped to this restore**, app-role SELECT returned counts, `has_table_privilege` reported SELECT=true/INSERT=false, and isolated API GET `/health`/`/ready` returned 200. Original staging/development databases were not altered during this probe. |
| Restored-snapshot tenant/store functional isolation | UNVERIFIED | The retained restore contains only one store and no orders/payments. Composite relationships have zero orphan rows, and prior PostgreSQL integration tests cover cross-store authorization, but this specific read-only snapshot cannot exercise a cross-store HTTP request. Rehearse on a new multi-store isolated recovery copy. |
| Full authenticated/transactional recovery on restored snapshot | UNVERIFIED | The retained snapshot has no captured session or QR table. Valid HTTP login would create a session and violate the read-only evidence rule; only anonymous 401 was tested. Rehearse authenticated recovery on a **new isolated copy**, not this evidence DB. |
| Backup failure detection and valid latest archive | VERIFIED | A PostgreSQL-unavailable interval had produced an invalid 80-byte Restic snapshot while falsely logging success. `backup.sh` now checks every command explicitly; invalid-host failure probe exited 1 without a success marker. New snapshot `31ce207a` contains 265,351 bytes, passes `restic check` and `pg_restore --list`. Retain/quarantine old snapshot `6ddbb752`; never select it for recovery. |
| 15-minute RPO under outage | FAILED | Latest valid snapshots at 11:19:42 and 11:38:41 UTC were about 19 minutes apart; the intervening 11:28:58 snapshot is invalid. Add failed-backup alerting and prove a sustained RPO drill before pilot. |
| Off-machine encrypted backup copy and restore | BLOCKED | Only the local encrypted Docker volume exists. Operator must supply protected off-host storage and verify copy, retention and restore; no paid infrastructure was created. |
| Restaurant TLS/DNS, LAN, printers and physical devices | BLOCKED | No operator-owned domain, public certificate, POS/tablet/mobile/printer or restaurant network was provided. Execute hardware, network-loss and peripheral acceptance on site. |
| Operator training, alerting, incident response and target RTO | UNVERIFIED | Local drills do not measure real-site recovery or staff procedures. Assign owners, alert destinations and run an observed timed recovery rehearsal. |
| Live card acquiring | UNVERIFIED | Provider credentials/approval are absent; production card processing remains disabled. Cash and manually verified bank transfers require operator acceptance. |
| Source-control change inventory | BLOCKED | This workspace has no `.git` directory; `git status --short` reports “not a git repository”. Preserve the current tree and review changes in the authoritative checkout before release. |

**Local staging verification and restaurant acceptance are separate gates.** Keep NO-GO while any critical row is FAILED, BLOCKED or UNVERIFIED.

**Next milestone:** connect an operator-controlled encrypted off-machine backup destination with failure/staleness alerts, prove the 15-minute RPO and timed restore into a new isolated database with real app-role grants, then run physical POS/KDS/QR/printer and staff acceptance on the restaurant LAN. Retain the invalid snapshot as incident evidence until retention approval.

Current review: **2026-10-23**. **Local infrastructure recovery and the requested verification milestone: VERIFIED. Restaurant rollout: NO-GO pending target-infrastructure and operator acceptance.** This is not production certification. Earlier Docker/Redis blockers were resolved; old milestone notes are historical.

| Requirement | Status | Actual evidence / remaining work |
|---|---|---|
| Docker Engine access and existing inventory inspection | VERIFIED | Desktop Linux Engine 29.1.2 is accessible with authorized commands outside the Codex sandbox. Sandbox access denial is not evidence that Docker is unavailable. |
| Preserve existing Redis/development data | VERIFIED | Redis uses the retained `omnihub_redis_data` volume. On October 23 the prior Redis container was absent; only its container/network were created using that volume. No existing container/volume was removed or reset. PostgreSQL used the existing `.local/postgres` cluster. |
| Redis connectivity, API dependency readiness and authentication | VERIFIED | Redis PING returns PONG; `/ready` returns 200 with database/Redis healthy; successful browser logins reach the real APIs. Fail-closed outage policy remains enabled. |
| Redis-backed shared counters and multiple API processes | VERIFIED | 2 Redis tests pass: atomic counts/TTLs and actual HTTP requests to two separate API processes sharing a limit (400, 400, 429). Only unique test keys are cleaned up. |
| Socket.IO kitchen delivery between browsers | VERIFIED | The final realtime E2E observes real acceptance/preparation frames in cashier/kitchen clients. Accepted-order push and kitchen visibility complete within five seconds after commit. REST polling alone cannot satisfy the frame assertions. |
| Reconnection and new events after transport loss | VERIFIED | A proxy forwards real WebSocket traffic unchanged, closes the transport, then the test requires a new authenticated handshake and subsequent committed events. Browser offline emulation alone is not used as proof of socket disconnection. |
| Offline KDS durable replay and conflict reconciliation | VERIFIED | Final E2E passes cached reload, ordered START/READY replay, duplicate confirmation and competing-server-version conflict with dependent commands held for review. |
| Device authorization, station assignment and revocation | VERIFIED | Final E2E verifies registration, assignment/reconnect, rejects kitchen handshakes without a device, closes revoked device sockets, rejects revoked reads/register/sync/reconnect, confirms no order mutation from rejected replay, and checks revocation audit history. |
| Employee invitation workflow | VERIFIED | Manager creates an invitation through the UI, acceptance uses the real public API, and the invited employee signs in and registers a device. This is not a separate end-to-end test of the invitation acceptance page. |
| POS, catalog, inventory, payments, refunds and cash shifts | VERIFIED | 27 PostgreSQL integration tests passed during this milestone; final 9/9 Playwright suite passes POS/payment/refund/report, matching/discrepancy shift close and catalog workflows. Existing fixtures/financial records remain retained. |
| QR ordering and responsive layouts | VERIFIED | Final Playwright includes table/QR creation, SVG download, mobile guest ordering/private tracking; existing desktop, 390px mobile and 820px tablet checks pass. |
| Lint, typecheck, unit tests and production build | VERIFIED | Lint/typecheck pass; 16 unit tests and Contracts/API/Next production build pass on the final application implementation. |
| Backup archive, readability and checksum | VERIFIED | PostgreSQL 18.6 tools in an isolated container generated a 2,336,896-byte custom archive; readability and SHA-256 match. Dump remains in ignored local storage. Native Windows client binaries remain absent. |
| Isolated restore, schema, counts and integrity | VERIFIED | New restore DB retained. 37 table counts, schema metadata and 13 completed migrations match; stock/ledger, payment/refund and closed-shift checks show zero violations. Restore 5.301s; restore plus validation 71.983s. Backup hash and restored counts were rechecked successfully on October 23. |
| Pilot TLS/proxy, secure cookies, secrets/ACL/logging on deployed infrastructure | BLOCKED | No actual pilot TLS/proxy deployment or restaurant device environment was supplied for acceptance. Local HTTP tests do not verify this requirement. |
| Encrypted off-host backups and scheduled recovery operation | NOT IMPLEMENTED | The verified drill is local. Off-host encryption, scheduling, retention ownership, alerting and measured restaurant RTO/RPO still need operator setup and verification. |
| Controlled API/worker restart and operational failure drills | NOT IMPLEMENTED | No automated active-order process-failure drill is included. Ordinary process startup and browser transport reconnection are verified; these do not prove a controlled mid-transaction recovery drill. |
| Live card acquiring and signed provider webhook integration | NOT IMPLEMENTED | Card processing stays disabled. Manual bank verification and cash remain the supported pilot payment paths. |
| Load, penetration, accessibility and staff acceptance | NOT IMPLEMENTED | Automated regression passing does not provide these deployment/operational results. |

## Reproduce the local verification

Use the existing development PostgreSQL cluster; do not start Compose PostgreSQL over the same port or reinitialize its data. Inspect `docker compose ps -a` first. Start an existing Redis container with `docker compose start redis`; if the container is absent but its named volume exists, `docker compose up -d --no-deps --no-recreate --wait redis` recreates only the missing service. Verify PING.

The local build uses `NEXT_PUBLIC_API_URL=http://localhost:4001`; the test API uses port 4001 and local-only `AUTH_LOGIN_RATE_LIMIT=100`. Playwright uses `API_BASE_URL=http://localhost:4001`. Redis, PostgreSQL, API, worker and built web must run. The ordinary login limit remains 10/minute. See TESTING.md for commands and BACKUP_AND_RECOVERY.md for the verified tooling-container drill. Backup contents and trace artifacts must remain private.

## Go/no-go

**NO-GO for a public restaurant rollout until critical deployment and operator gates are verified.** The previous local Redis/realtime and isolated-restore blockers are closed. Next work is a controlled rehearsal on restaurant hardware: TLS/proxy/session security, device and network failures, active-order API/worker restart, encrypted off-host recovery, staff offboarding and training. Keep live card processing disabled. No push, merge or deployment was performed.
