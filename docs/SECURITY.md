# Security controls and remaining work

## Implemented in the application

- PostgreSQL is authoritative; write paths use scoped tenant/store predicates, transactions, idempotency receipts and audit/outbox records.
- Employee access uses hashed opaque sessions in HttpOnly, SameSite=Strict cookies, with current store membership/role checked on requests. Secure cookie is on by default; `SESSION_SECURE=false` is only for local HTTP development.
- Exact `WEB_ORIGIN` enforcement on write requests, credentialed CORS for that origin, Helmet headers, and configurable trusted proxy CIDRs.
- QR/table-session/order-tracking and employee invitation bearer values are random capabilities; only hashes are stored. Customer tracking exposes one order's fulfillment status.
- KDS IndexedDB has no bearer session token. Sync checks current employee membership, device/user/store binding, revocation, station scope and command version/idempotency.
- Public/auth rate limits use Redis atomic Lua counters shared across replicas and fail closed on Redis loss. Raw client addresses and request bodies are not logged. Token-bearing QR, order-status and invitation paths are redacted in structured access logs.
- Payment/stock/order operations use integer VND and transactional conflict controls; historical order prices and recipe snapshots are retained.

## Automated CI/CD, Supply-Chain & Hygiene Controls (Milestone 0.2)

- **Workflow Least Privilege:** Both `.github/workflows/ci.yml` and `.github/workflows/security.yml` declare `permissions: contents: read` at workflow level, granting write/read scopes only to the specific jobs that require them (`security-events: write` and `actions: read` for `codeql`; `pull-requests: read` for `dependency-review`).
- **Blocking Dependency Audit:** `pnpm audit --prod --audit-level high` gates every push, pull request, and weekly schedule (`cron: '0 3 * * 1'`), backed by explicit `pnpm-workspace.yaml` transitive overrides and `zod ^4.6.7`.
- **Static CodeQL Analysis:** GitHub CodeQL (`github/codeql-action@v4`, `javascript-typescript`, `security-extended` query suite) scans backend, shared contract, script, and frontend TypeScript/JavaScript sources.
- **Pull Request Dependency & License Review:** `actions/dependency-review-action@v4` checks dependency diffs on `pull_request` events (`fail-on-severity: high`, denying `GPL-2.0`, `GPL-3.0`, and `AGPL-3.0` licenses).
- **Repository Hygiene & Shell Validation:** `pnpm security:hygiene` (`scripts/check-security-hygiene.ts`) scans all git-tracked files to block committed `.env*` secrets (except `.env.example`), PEM private key headers, certificate/key bundles, runtime/artifact directories (`.local/`, `.tmp/`, `coverage/`, `playwright-report/`, `test-results/`), high-confidence token prefixes, and non-local embedded DB/Redis credential URIs; `sh -n` validates syntax across all tracked POSIX `.sh` scripts. CI failure logs and Playwright annotation summaries explicitly sanitize line output and retain diagnostic artifacts only on failure.

## Deployment responsibilities

Use TLS, least-privilege PostgreSQL credentials, Redis ACLs/private networking, secret-manager injection, exact proxy CIDRs, backups, monitoring, patching and restricted operator access as described in [DEPLOYMENT.md](DEPLOYMENT.md). No production deployment or live payment-provider integration is included.

## Gaps requiring evidence before a restaurant pilot

Webhook endpoints and provider signature/replay verification are not implemented; live card processing remains disabled. The 2026-10-22/23 local verification passed two-client Socket.IO, shared Redis limits, device revocation and isolated restore. The new separate local staging Compose configuration adds TLS termination, exact proxy trust, secure-cookie/origin startup checks, Redis ACLs, SCRAM database auth and a restricted app role. Its actual acceptance result is recorded in `PILOT_READINESS_CHECKLIST.md`; local CA and local Docker networking are not deployed restaurant controls. Rate-limit keys use unsalted SHA-256 of client IP; this prevents raw addresses in Redis keys but is not an anonymization guarantee. Review data retention, privacy/legal notices, employee offboarding, account recovery, load/penetration/accessibility and physical-device behavior with the operator before public customer use.

The security gate now validates production configuration before API/worker startup, including HTTPS origin, secure cookies, high-entropy QR secret, one trusted proxy IP, password-bearing database and Redis URLs, and transport mode. Cross-host data connections require verified TLS. The access log redacts capability path values and drops query strings. Caddy intentionally has no access log. The npm advisory audit after lockfile updates must be rerun for every release; it does not replace image, container or manual security review.
