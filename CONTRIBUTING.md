# Contributing to OMNIHUB

Thank you for your interest in contributing to OMNIHUB. This project maintains strict database, concurrency, security, and verification standards aligned with production-grade engineering practices.

---

## 1. Branching & Git Workflow

- **Never commit or push directly to `main`.** All changes must land through reviewed Pull Requests.
- Always branch from an up-to-date `main`:
  ```sh
  git checkout main
  git pull origin main
  git checkout -b <type>/<short-kebab-description>
  ```
- **Branch naming conventions:**
  - `feat/<scope>` — New business capabilities or API/UI features
  - `fix/<scope>` — Bug fixes and invariant/regression repairs
  - `docs/<scope>` — Documentation, runbooks, and governance updates
  - `refactor/<scope>` — Internal code cleanup without behavior change
  - `test/<scope>` — Adding or hardening automated tests
  - `ci/<scope>` — GitHub Actions workflow or build pipeline changes
  - `chore/<scope>` — Tooling, dependency, or configuration maintenance
- **Never rewrite published Git history** (no force-push to `main` or shared branches).

---

## 2. Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional-scope>): <imperative lowercase summary>
```

Allowed types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation or governance changes only
- `refactor`: Code restructuring without behavior or API changes
- `test`: Test additions or fixes
- `ci`: CI/CD workflow changes
- `build`: Build system or dependency changes
- `chore`: Maintenance tasks

Examples:
- `feat(inventory): add multi-warehouse stock balance model`
- `fix(pos): reject stale product price during checkout`
- `docs(readme): document local backup verification flow`

---

## 3. Pull Request Requirements

- Keep PRs **focused, scoped, and reviewable** — avoid mixing unrelated refactors with feature or documentation changes.
- Complete all sections of [.github/pull_request_template.md](.github/pull_request_template.md).
- Update relevant technical documentation (`docs/internal/IMPLEMENTATION_STATUS.md`, `docs/internal/TESTING.md`, `docs/internal/API_DOCUMENTATION.md`, schema/lifecycle docs) whenever behavior, schemas, or verified test status changes.
- **Never commit** `.env`, `.local/`, `.tmp/`, build outputs (`.next/`, `dist/`), database dumps, logs, or Playwright trace artifacts.
- Do not expand CI scope, database schemas, or application behavior silently inside documentation-only PRs.

---

## 4. Code Review Expectations

Every change touching runtime code, schemas, or deployment scripts should be reviewed against OMNIHUB invariants:

- **Tenant & Store Isolation:** Every query, mutation, and socket room must enforce authenticated `(tenantId, storeId)` scope inside both controller/service boundaries and database constraints ([docs/internal/AUTHORIZATION_MATRIX.md](docs/internal/AUTHORIZATION_MATRIX.md)).
- **Transaction & Concurrency Safety:** Multi-row stock, order, shift, and payment writes must run in PostgreSQL serializable transactions with bounded retry handling, sorted locking where applicable, and `CommandReceipt` idempotency ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- **Exact Arithmetic:** Use `Decimal(18,3)` for ingredient quantities and integer VND (no floating-point currency math) ([docs/internal/DOMAIN_MODEL.md](docs/internal/DOMAIN_MODEL.md)).
- **Fail-Closed Security:** Do not bypass origin verification, capability hashing, Redis outage protection, or production startup validation ([docs/internal/SECURITY.md](docs/internal/SECURITY.md)).
- **Honest Verification Claims:** Report exact commands run, exact outcomes, and known limitations.

---

## 5. Test Requirements

Use `pnpm.cmd` instead of `pnpm` in Windows PowerShell if execution policy blocks `pnpm.ps1`.

### Required for All Code Changes
```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### Required When Touching Database, API, Auth, Realtime, Payments, Inventory, or UI Flows
```sh
pnpm db:generate
pnpm db:migrate          # Against an isolated local/CI database — NEVER production
pnpm test:integration    # 27+ PostgreSQL transactional & concurrency tests
pnpm test:redis          # Requires running Redis + built API
pnpm test:e2e            # Requires running PostgreSQL, Redis, built API/web & worker
```

### Documentation / Governance-Only Changes
- Validate all relative Markdown links and references.
- Validate YAML syntax for any workflow or issue template edits.
- Verify `git diff` confirms zero unintended source code, schema, or test mutations.

Never claim a test suite passed unless you executed it against the final state of your branch and observed all assertions pass without skipping or weakening invariants. Do not treat compilation or mocked unit tests as proof of PostgreSQL concurrency, Redis delivery, or browser behavior.

---

## 6. Definition of Done

A PR is ready for review when:

1. Scope matches the linked issue or task without unapproved additions.
2. Required static checks (`typecheck`, `lint`, `build`) and applicable automated test suites pass on the final diff.
3. Any database schema change includes an additive Prisma migration (`prisma/migrations/`) and updated invariants/documentation.
4. Security boundaries, origin validation, and capability redaction remain intact.
5. `Verification` in the PR description clearly separates **executed checks** from **checks not executed** and accurately states any remaining limitations or blocked pilot gates.

---

## 7. Security Reporting

**Do not report security vulnerabilities, exposed secrets, or live exploit details in public GitHub Issues or Pull Requests.**

- Never post `.env` values, connection strings, tokens, cookies, database dumps, or private test traces in issues or PR comments.
- If you discover a security flaw in OMNIHUB, contact the repository maintainer privately via GitHub security/private channels before public disclosure, and include reproduction steps, affected files, and impact assessment.
- Review [docs/internal/SECURITY.md](docs/internal/SECURITY.md), [docs/internal/QR_ORDERING_SECURITY.md](docs/internal/QR_ORDERING_SECURITY.md), and [docs/internal/DEPLOYMENT.md](docs/internal/DEPLOYMENT.md) for existing security assumptions and out-of-scope pilot gates.

---

## 8. AI-Assisted Engineering Transparency

OMNIHUB welcomes transparent, disciplined use of AI engineering assistants alongside strict human accountability:

- **Human Ownership:** The human author/maintainer is solely responsible for architectural decisions, security checks, verifying executed test results, and reviewing/approving every Pull Request.
- **No Synthetic Attribution:** Never attribute AI models or automated agents as human Git contributors, `CODEOWNERS`, or independent code reviewers.
- **No Fabricated Evidence:** AI-generated drafts must never invent passing CI runs, benchmarks, screenshots, production deployments, or external test evidence. Every factual claim in code, PRs, and documentation must be verified directly from repository state and observed tool output.
