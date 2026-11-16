# Metrics Architecture (`M2-T02`)

This document describes the Prometheus observability, Golden Signals instrumentation, cardinality controls, `/metrics` endpoint security, and scrape topology implemented for OMNIHUB backend services (`omnihub-api` and `omnihub-worker`).

---

## 1. Core Architecture & Module Layout

| Module | Responsibility |
|---|---|
| [`apps/api/src/observability/metrics.ts`](../apps/api/src/observability/metrics.ts) | `createMetricsRegistry`, bounded label normalizers, Prometheus `Counter`/`Gauge`/`Histogram` instruments via `prom-client`, optional single-guard `collectDefaultMetrics`, TTL-cached coalesced `refreshOutboxBacklog(db)` helper, and `close()` lifecycle cleanup. Exports `apiMetrics` and `workerMetrics`. |
| [`apps/api/src/observability/metrics-endpoint.ts`](../apps/api/src/observability/metrics-endpoint.ts) | `createMetricsRequestHandler`, `isLoopbackAddress`, `isMetricsRequestAuthorized` (Bearer token via constant-time `timingSafeEqual` on SHA-256 digests, or unproxied loopback fail-closed gate). |
| [`apps/api/src/observability/http-middleware.ts`](../apps/api/src/observability/http-middleware.ts) | `createHttpSecurityLoggingMiddleware` high-resolution `process.hrtime.bigint()` request duration tracking, `http_requests_total`, `http_requests_in_flight` (with `close` abort guard), and `ORIGIN_DENIED` error counts. Excludes `/metrics` self-scrapes from API SLO metrics. |
| [`deploy/Caddyfile`](../deploy/Caddyfile) | Edge TLS reverse proxy blocking external requests matching `/metrics*` with HTTP `403` before forwarding to `web:3000` or `api:4000`. |

### Process & Scrape Topology (`api` vs `worker`)
- **`omnihub-api` (`main.ts` / `http-app.ts`):** Exposes protected `GET /metrics` alongside HTTP, rate-limit, `CommandBus`, PostgreSQL error, and Socket.IO metrics, plus live PostgreSQL-backed `outbox_pending_count` and `outbox_oldest_pending_age_seconds` refreshed on scrape through the composite `Outbox(deliveredAt, createdAt)` index (coalesced with a `5_000 ms` TTL cache to prevent scrape bursts from overloading the database).
- **`omnihub-worker` (`worker.ts` / `outbox.ts`):** Tracks per-batch duration, published/failed/quarantined events, and worker health/failure streak inside `workerMetrics`. When `WORKER_METRICS_PORT` is explicitly configured (disabled by default), `worker.ts` binds an isolated HTTP `/metrics` server on `WORKER_METRICS_HOST ?? 127.0.0.1` using the same `createMetricsRequestHandler` guard.

---

## 2. Prometheus Metric Catalog

All metrics enforce strictly bounded finite label sets (`service="omnihub-api"` or `"omnihub-worker"` default label). High-cardinality identifiers (`tenantId`, `storeId`, `userId`, `email`, client `IP`, `correlationId`, raw URLs, `orderId`, `token`) are **prohibited** and never recorded.

| Metric Name | Type | Labels | Meaning & Operational Use |
|---|---|---|---|
| `http_requests_total` | `Counter` | `method`, `route`, `status_class` | Completed HTTP requests (excluding `/metrics` scrapes). Used for RPS and `4xx`/`5xx` error ratios. |
| `http_request_duration_seconds` | `Histogram` | `method`, `route`, `status_class` | End-to-end request latency distribution (buckets `0.005s`..`10s`) for `histogram_quantile` (`p50`, `p95`, `p99`). |
| `http_requests_in_flight` | `Gauge` | `method` | Currently active in-flight HTTP requests; cleaned up on both `finish` and aborted `close` events. |
| `http_errors_total` | `Counter` | `method`, `route`, `code` | HTTP exceptions and edge denials (`ORIGIN_DENIED`, `INTERNAL_SERVER_ERROR`, bounded error codes). |
| `rate_limit_decisions_total` | `Counter` | `prefix`, `outcome` | Rate limiter outcomes (`allowed`, `blocked_429`, `unavailable_503`) by sanitized rule prefix (`login`, `qr-order`, `public`, `webhook`). |
| `command_bus_attempts_total` | `Counter` | `operation`, `outcome` | CommandBus execution attempts partitioned by `@omnihub/contracts` `EventType` (`success`, `idempotent_replay`, `retry_p2034`, `retry_p2002`, `retry_transient`, `conflict_exhausted`, `error`). |
| `db_transaction_retries_total` | `Counter` | `operation`, `reason` | Serializable transaction retry frequency (`p2034_serialization`, `p2002_unique`, `pg_transient_retry`). |
| `db_errors_total` | `Counter` | `code` | Database errors observed at transaction/HTTP/scrape boundaries (`p2024_pool_timeout`, `p2034_serialization`, `p2002_unique`, `db_unavailable`, `prisma_other`). |
| `outbox_pending_count` | `Gauge` | *(default only)* | Number of undelivered `Outbox` rows (`deliveredAt IS NULL`). |
| `outbox_oldest_pending_age_seconds` | `Gauge` | *(default only)* | Age in seconds of the oldest undelivered `Outbox` event (`0` when caught up). |
| `outbox_dead_letter_total` | `Gauge` | *(default only)* | Current count of malformed `Outbox` events quarantined in worker memory. |
| `outbox_quarantined_events_total` | `Counter` | *(default only)* | Cumulative malformed `Outbox` events quarantined during worker runs. |
| `outbox_events_total` | `Counter` | `outcome` | Per-event processing count (`published`, `failed`, `invalid_quarantined`). |
| `outbox_batch_duration_seconds` | `Histogram` | `outcome` | Outbox batch transaction duration (`ok`, `degraded`, `budget_exceeded`, `error`; buckets `0.005s`..`15s`). |
| `outbox_worker_health` | `Gauge` | *(default only)* | Worker loop state (`1` = healthy, `0` = degraded backoff or stopped). |
| `outbox_worker_consecutive_failures` | `Gauge` | *(default only)* | Consecutive failed polling iterations driving exponential backoff. |
| `realtime_connected_sockets` | `Gauge` | *(default only)* | Active authenticated Socket.IO connections held by the current API process. |
| `realtime_connections_total` | `Counter` | `outcome` | Socket.IO connection handshakes (`accepted`, `rejected`). |
| `realtime_disconnects_total` | `Counter` | `reason` | Normalized Socket.IO disconnection reasons (`client_disconnect`, `server_disconnect`, `transport_close`, `transport_error`, `ping_timeout`, `forced_close`, `other`). |
| `realtime_events_broadcast_total` | `Counter` | `outcome` | Operational event delivery from Redis subscriber to Socket.IO (`broadcast`, `invalid_payload`, `error`). |
| `process_*` / `nodejs_*` | Default runtime metrics | `service` | Single-guarded `prom-client` default Node.js CPU, heap, GC, and event-loop lag metrics in runtime processes. |

---

## 3. Detecting Latency, Backlog & Contention (PromQL Reference)

- **p95 HTTP latency per route:** `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`
- **HTTP 5xx error ratio:** `sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m]))`
- **Outbox lag alert condition:** `outbox_oldest_pending_age_seconds > 30` or `outbox_pending_count > 100`
- **Serialization contention / pool exhaustion:** `rate(db_transaction_retries_total{reason="p2034_serialization"}[5m])` and `increase(db_errors_total{code="p2024_pool_timeout"}[5m])`
- **Rate-limiter fail-closed / brute-force spikes:** `rate(rate_limit_decisions_total{prefix="login",outcome=~"blocked_429|unavailable_503"}[5m])`

---

## 4. Cardinality & Security Controls

1. **Bounded Route Normalization (`normalizeHttpRouteLabel`):** Matched NestJS controllers emit `req.route.path` templates (e.g. `/orders/:id/payments`). Pre-route failures and arbitrary `404` scanner URLs normalize only against finite static API prefixes and collapse everything else to `"unmatched"`, preventing attacker-induced memory exhaustion.
2. **Defense-in-Depth on `/metrics`:**
   - **Edge proxy ([deploy/Caddyfile](../deploy/Caddyfile)):** Immediately returns `403` for `/metrics*` before forwarding external traffic.
   - **In-process rate limiter (`buildMetricsRateLimitOptions` / `BoundedMemoryRateLimitStore`):** Mounted inline via `express-rate-limit` ahead of `createMetricsRequestHandler` on both API `GET /metrics` (`http-app.ts`) and Worker `GET /metrics` (`worker.ts`). Uses fixed-window O(1) LRU storage bounded to `METRICS_RATE_LIMIT_MAX_ENTRIES` (default `1024`, zero background `setInterval` timers, torn down on shutdown), keys on a SHA-256 digest of the direct socket peer IP (`req.socket.remoteAddress`, ignoring `X-Forwarded-For`, normalizing `/64` IPv6 prefixes), defaults to `120` req / `60_000 ms`, returns `429 RATE_LIMITED` with `Retry-After` and logs `METRICS_RATE_LIMITED` without storing raw client IPs, and stays Redis-independent so Prometheus continues scraping during Redis outages.
   - **API / Worker handler (`createMetricsRequestHandler`):** When `METRICS_AUTH_TOKEN` is set, requires exact `Authorization: Bearer <token>` compared via `timingSafeEqual` on SHA-256 digests (`403 METRICS_ACCESS_DENIED` otherwise). When `METRICS_AUTH_TOKEN` is unset, allows **only direct unproxied loopback** (`127.0.0.1` / `::1` with no `X-Forwarded-For`, `Forwarded`, or `X-Real-IP` headers) and logs denied access attempts via `apiLogger.security('warn', 'METRICS_ACCESS_DENIED', ...)`.

---

## 5. Graceful Shutdown & Known Limitations

- **Graceful teardown:** `main.ts` and `worker.ts` invoke `apiMetrics.close()` / `workerMetrics.close()` during shutdown (`SIGINT`/`SIGTERM`/fatal abort) before flushing loggers, clearing registered collectors, stopping backlog refreshes, and closing any optional `WORKER_METRICS_PORT` listener. `collectDefaultMetrics` is guarded so duplicate global Node `PerformanceObserver` handles are never registered.
- **Dependency note:** Uses `prom-client@15.1.3` (`Apache-2.0`, zero advisories under `pnpm audit --prod --audit-level high`, explicitly selected in `M2_IMPLEMENTATION_PLAN.md`; npm notes upstream successor `@prometheus-io/client` for future major upgrades).
- **Current scope limits:**
  - `realtime_connected_sockets` measures connections per API process until multi-replica Socket.IO adapter coordination (`M2-T09`) is implemented.
  - PostgreSQL transaction retries retain M1 retry/P2002 semantics until `M2-T03` is executed.
  - Per-worker batch counters live in the worker process; configure `WORKER_METRICS_PORT` on private loopback/sidecar network if scraping worker-only batch metrics alongside API `/metrics`.
