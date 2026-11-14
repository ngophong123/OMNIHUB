# Deployment hardening baseline

## Local staging access update — 2026-10-24

Docker Engine 29.1.2 was available through elevated commands. Ordinary sandbox `docker info` was denied on the Windows named pipe; no Docker Desktop reset or service modification was needed. The existing PostgreSQL, Redis, backup, API, worker and proxy services remained on their original data volumes. Only the web container was updated to image `sha256:3d0d851e66be10f5f08e344dec8743cc6ee3e76f852b340a729d701855d4ec4c` for the POS catalog-refresh fix. Strict-CA HTTPS web and API readiness returned 200, and the final complete Playwright run passed 9/9. Details and NO-GO gates are in [PILOT_READINESS_CHECKLIST.md](PILOT_READINESS_CHECKLIST.md). This supersedes the Docker-blocked note below; no public deployment occurred.

## Backup/DR staging continuation — 2026-10-24

**Restaurant deployment remains BLOCKED / pilot NO-GO.** The retained local staging Compose file now adds persistent verified-backup state and an independent `backup-monitor` container. The backup schedule is 300 seconds, maximum verified recovery-point age is 900 seconds, and monitoring runs every 30 seconds. Backup and monitor state is retained on `staging_backup_state`; existing PostgreSQL, Redis, Restic repository and evidence volumes were not deleted. The separate off-machine Restic copy tool requires an approved HTTPS repository allowlist and independently controlled password; no destination was supplied and no upload occurred. Local JSON alerts require an operator-controlled delivery channel before pilot.

The last executed local recovery drill on 2026-10-23 verified a new isolated restore and application login/store isolation in 14.564 seconds. The 60-minute RTO is a proposed local target, not a restaurant-site service guarantee. Two valid backups 300 seconds apart do not establish sustained 15-minute RPO, and the earlier 19-minute gap failed that target. An approved off-machine restore and physical restaurant acceptance are still required.

This continuation cannot run the final staging browser regression: Docker Desktop reported unable to start, WSL enumeration returned `E_ACCESSDENIED`, and `com.docker.service` was stopped/inaccessible to `Start-Service`. An authorized Windows administrator must restore Docker Desktop service/WSL access and verify `docker info`; then rerun the isolated recovery drill and complete HTTPS Playwright against the exact final build. Do not reset Docker or remove any volume as a troubleshooting shortcut.

Git safety: no `.git` directory was found in this workspace or checked parent directories, and no approved remote is known. Before initializing, identify whether an authoritative repository/history exists, preserve a private inventory/hash of the current tree, and review `.gitignore` for secrets, `.local` evidence and backups. If this is confirmed as a new project, initialize Git **locally only**, review `git status` and staged paths before any commit, and keep publication subject to separate authorization. No repository was initialized or published during this milestone.

## Final local staging observation — 2026-10-23 11:42 UTC

**Status: VERIFIED for isolated local staging; BLOCKED for a restaurant deployment.** Docker Desktop was stopped at session start. Starting the installed Desktop app restored the existing Compose project and volumes without reset. `docker compose -f deploy/compose.staging.yml build api web` produced API image `sha256:e6914c85f5360363fb65fb53c6ecdcba046fccc2408ff8a02dac2ea13baf967d` and web image `sha256:c40d34d09c19dd3e08ae8388f7bd23a435df47abe55ef58b9d843f7b7c490a1a`; only API, worker and web containers were recreated. PostgreSQL, Redis and encrypted-backup volumes remained intact.

Strict Node TLS verification against the retained local Caddy CA passed on 8443/8444 (SPKI `2Y1Gpo3iH9icj1QlITEyMd0KAYJVx7W+oyrb/I6afuk=`). Through that CA, `/ready` returned 200, web returned 200, a foreign Origin returned 403, allowed Origin returned 200, HSTS was present and HTTP 8080 redirected 308. Windows Schannel `curl --cacert` rejected this local CA because its revocation status is unknown; this is a Windows tooling limitation, **not** a reason to use `curl -k` for acceptance. Use the strict `pnpm exec tsx scripts/staging-tls-trust.ts` probe and `NODE_EXTRA_CA_CERTS` for the local test client. The earlier staging drill verified Secure/HttpOnly/Strict cookies and trusted-proxy behavior on the same configuration. Caddy continues to publish loopback ports only; PG/Redis remain internal.

The retained restore DB required `GRANT USAGE ON SCHEMA public` and `GRANT SELECT ON ALL TABLES` to `omnihub_app` before the isolated restore API could read application tables. The earlier restore used `pg_restore --no-owner --no-acl`; those flags do not reproduce the application grants. This grant was applied **only to the retained isolated restore**, and its app role has no INSERT privilege there. Future restore runbooks must explicitly reapply reviewed least-privilege grants to a new target and verify real app-role reads. `/ready` alone is insufficient: it executes `SELECT 1` and returned 200 even when app-table SELECT failed. Valid authenticated recovery still requires a new disposable copy because the retained evidence DB was kept read-only.

**BLOCKED:** operator-owned DNS and publicly trusted certificates, target LAN/firewall and hardware, off-machine encrypted backup, alert delivery, staff runbooks and measured target RPO/RTO. This local Compose setup is not a public deployment. Source-control review is also blocked because this workspace has no `.git` directory.

## Isolated local staging (2026-10-23)

`deploy/compose.staging.yml` is a separate Compose project named `omnihub-staging`. It allocates its own PostgreSQL, Redis, Caddy and encrypted-backup volumes, and never mounts the development database or `omnihub_redis_data`. The only published ports are `127.0.0.1:8080` (redirect) and `127.0.0.1:8443/8444` (HTTPS web/API). The application network is `internal: true`; Caddy alone also joins a host-facing `edge` network so Docker Desktop can publish those ports. Caddy has a fixed `172.29.87.250` address on the private network for Express proxy trust. Verify this subnet is unused before starting. A browser outside this Windows host cannot reach these ports. Do not use this local CA or `localhost` names for restaurant devices.

```powershell
node --import tsx scripts/prepare-staging.ts
docker compose -f deploy/compose.staging.yml config --quiet
docker compose -f deploy/compose.staging.yml build api web backup
docker compose -f deploy/compose.staging.yml up -d --wait postgres redis
docker compose -f deploy/compose.staging.yml --profile tools run --no-deps migrate
docker compose -f deploy/compose.staging.yml --profile tools run --no-deps seed
docker compose -f deploy/compose.staging.yml up -d --wait api worker web proxy
```

The secret preparer creates random values under ignored `.local/staging/secrets` only if absent. Never rotate credentials while the corresponding volumes exist. The `seed` command is an explicit local acceptance fixture; do not seed restaurant data. The app role has DML privileges, the migration owner has DDL privileges, and the backup role is read-only. The PostgreSQL host authentication is SCRAM-SHA-256; the Redis default user is disabled and the `app` ACL is limited to health checks, rate-limit keys and the outbox channel. The secrets are mounted as Compose secret files and read on process startup; they do not enter image layers or command arguments. Secure shared hosting still requires a real secret manager, host ACL review and a managed private network.

Caddy issues a **local internal CA** certificate for `localhost`, forwards WebSocket upgrades, sends explicit `X-Forwarded-For` and `X-Forwarded-Proto`, and redirects port 8080 to TLS. The API accepts only the exact `https://localhost:8443` origin, issues `Secure`, `HttpOnly`, `SameSite=Strict` cookies, trusts only the Caddy container IP, and refuses unsafe production configuration before listening. Caddy access logs are disabled because QR/invitation URLs contain bearer capabilities; the API emits structured redacted access logs. `/health` is liveness, `/ready` requires PostgreSQL and Redis, and the worker heartbeat becomes unhealthy when its processing loop or dependencies stall. The API handles SIGTERM by closing realtime, draining HTTP, then closing Redis and PostgreSQL within 25 seconds.

Run `scripts/staging-drills.ts` only against this fixed local project. Its service interruptions affect **staging only**; it does not accept a production URL. For a real pilot, replace `localhost` with operator-owned DNS/TLS, pin the proxy peer, restrict the internal network, configure certificate renewals/alerts, and verify on the actual restaurant LAN. `DATA_NETWORK_MODE=isolated-single-host` expressly permits database and Redis plaintext **inside this one host's private Docker network**. Cross-host deployments fail startup unless PostgreSQL uses `sslmode=verify-full` and Redis uses `rediss:` with certificate validation. The local staging certificate is not evidence of publicly trusted TLS.

OMNIHUB is not deployed or certified for production. Use this as the deployment contract for a controlled pilot.

## Network and TLS

Terminate HTTPS at a managed reverse proxy/load balancer. Redirect HTTP to HTTPS there, use a current TLS policy, and do not publish PostgreSQL 5432 or Redis 6379 to the public network. Put PostgreSQL and Redis on private networks with authentication, ACLs and firewall rules; use TLS connections when traffic crosses hosts. Configure backups off-host with encryption and access control.

Set `WEB_ORIGIN` to one exact HTTPS origin (no wildcard), `SESSION_SECURE=true`, and `TRUSTED_PROXY_CIDRS` to the exact proxy addresses/CIDRs. Do not trust all proxies. If the API runs in a container behind a proxy on another container, set `API_HOST=0.0.0.0`; the default binds to loopback for local development. Do not expose the API directly to the internet. The app enforces the configured origin on write requests and Helmet security headers; the proxy must preserve `Origin` and forward the original client address only from trusted peers.

## Secrets and storage

Supply `DATABASE_URL`, `REDIS_URL`, `QR_TOKEN_SECRET` and cookie/origin configuration through the deployment secret manager. Generate `QR_TOKEN_SECRET` with at least 32 random bytes. Never reuse `.env.example` credentials or commit `.env`. Use a least-privilege PostgreSQL role and a Redis ACL user limited to the application database/commands and Pub/Sub channel. Prefer secret-file mounts or environment injection over command-line arguments. Do not log connection strings, request bodies, cookies, authorization headers or bearer tokens.

Rate limits use an atomic Redis Lua counter shared by API instances. Auth, public QR, public API and webhook path prefixes have separate validated limit settings. Trusted proxy CIDRs determine client identity; stored keys contain only a SHA-256 address digest. A Redis failure returns 503 on these protected ingress paths; it never silently resets the counter per replica. Webhook provider endpoints are not implemented yet, so their route-specific signature/replay validation remains a prerequisite before adding one.

## Health, shutdown and operations

`GET /health` is liveness only. `GET /ready` checks PostgreSQL and Redis PING, which are required for DB-backed requests and protected ingress. It does not prove the worker is subscribed or Socket.IO reaches another browser; monitor worker heartbeat/outbox age and run the realtime E2E before pilot acceptance. API shutdown stops Socket.IO/Redis clients, disconnects Prisma and closes the HTTP app. Run the outbox worker as a separate supervised process and restart it independently.

Store UTC timestamps in PostgreSQL and configure each store's IANA business timezone/cutoff. Keep structured logs; request path credentials for QR, tracking and invitation acceptance are replaced with placeholders. Review logs for accidental secrets before exporting them.

## Required pre-pilot gates

Apply additive migrations with `pnpm db:migrate`, verify `pnpm exec prisma migrate status`, run lint/typecheck/build and unit/DB/Redis/browser tests against isolated pilot data, run a backup and isolated restore drill, and confirm TLS, Redis ACLs, DB role, proxy trust, cookies, alerts, recovery contacts and employee-device revocation on target hardware. Do not run restore verification against an existing database; use the supplied isolated-target script. Record actual evidence in `PILOT_READINESS_CHECKLIST.md`.
