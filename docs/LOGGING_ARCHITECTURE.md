# Logging Architecture (`M2-T01`)

This document describes the unified structured logging and asynchronous execution context architecture for OMNIHUB backend services (`omnihub-api` and `omnihub-worker`).

---

## 1. Core Components

| Module | Responsibility |
|---|---|
| [`apps/api/src/observability/request-context.ts`](../apps/api/src/observability/request-context.ts) | `AsyncLocalStorage<ExecutionContext>` store, validated correlation ID generation (`resolveCorrelationId`), scoped execution (`runWithLogContext`), lookup (`getLogContext`), and in-flight enrichment (`updateLogContext`). |
| [`apps/api/src/observability/logger.ts`](../apps/api/src/observability/logger.ts) | `StructuredLogger` implementation, `LOG_LEVEL` resolution (`debug`/`info`/`warn`/`error`/`fatal`), category helpers (`app`, `security`, `ops`), denylist + optional allowlist field sanitization, pattern scrubbing, failure-safe sink dispatch, and async `flush()` / `close()`. Exports shared singletons `apiLogger` and `workerLogger`. |
| [`apps/api/src/observability/http-middleware.ts`](../apps/api/src/observability/http-middleware.ts) | Express HTTP middleware `createHttpSecurityLoggingMiddleware` establishing per-request `AsyncLocalStorage` scope, validated `X-Correlation-ID` response headers, Origin CSRF gate logging (`ORIGIN_DENIED`), and `HTTP_ACCESS` completion logging with post-auth tenant/store/user context. |

---

## 2. Log Record Envelope & Categories

Every emitted record is serialized as a single-line JSON object via `JSON.stringify` with standardized top-level metadata:

```json
{
  "timestamp": "2026-11-15T10:15:01.091Z",
  "level": "info",
  "category": "application",
  "service": "omnihub-api",
  "code": "HTTP_ACCESS",
  "component": "http",
  "correlationId": "http-corr-valid-01",
  "tenantId": "t1",
  "storeId": "s1",
  "userId": "u1"
}
```

### Standard Envelope Fields
- **Always present:** `timestamp` (ISO-8601 UTC), `level` (`debug` | `info` | `warn` | `error` | `fatal`), `category` (`application` | `security` | `operational`), `service`, `code`.
- **Context-inherited (when active):** `component`, `correlationId`, `tenantId`, `storeId`, `userId`, `jobName`, `batchId`.
- **Envelope integrity:** `timestamp`, `level`, `category`, `service`, `code`, and `component` cannot be overwritten by arbitrary caller payload keys (`fields`); explicit `correlationId` passed in `fields` is preserved (used by the Outbox worker to emit the originating request's `correlationId` inside a batch context).

### Log Categories
1. **`application` (`logger.app` / default for `apiLogger`):** HTTP request access logs (`HTTP_ACCESS`) and domain execution events.
2. **`security` (`logger.security`):** Authentication failures/successes (`AUTH_LOGIN_FAILED`, `AUTH_LOGIN_SUCCEEDED`, `AUTH_SESSION_REJECTED`, `AUTH_MEMBERSHIP_DENIED`, `AUTH_REAUTHORIZE_REVOKED`), Edge Origin rejections (`ORIGIN_DENIED`), rate-limit rejections (`RATE_LIMITED`), WebSocket handshake rejections (`REALTIME_HANDSHAKE_REJECTED`), and store invitation lifecycle audits (`STORE_INVITATION_CREATED`, `STORE_INVITATION_REVOKED`, `STORE_INVITATION_ACCEPT_DENIED`, `STORE_INVITATION_ACCEPTED`).
3. **`operational` (`logger.ops` / default for `workerLogger`):** Global HTTP exception filter (`Errors`), Redis availability & rate-limiter fail-closed errors (`REDIS_READY`, `REDIS_UNAVAILABLE`, `RATE_LIMITER_UNAVAILABLE`), Outbox worker batch lifecycle (`OUTBOX_PUBLISHED`, `OUTBOX_RETRY`, `OUTBOX_RECOVERED`, `OUTBOX_EVENT_INVALID`, `OUTBOX_REDIS_READY`, `OUTBOX_REDIS_UNAVAILABLE`, `OUTBOX_STOPPED`, `OUTBOX_WORKER_FAILED`), Socket.IO Redis subscriber health (`REALTIME_REDIS_READY`, `REALTIME_REDIS_UNAVAILABLE`, `REALTIME_SUBSCRIBE_FAILED`, `REALTIME_EVENT_INVALID`, `REALTIME_BROADCAST_FAILED`, `REALTIME_REVALIDATE_FAILED`), and process startup/shutdown (`API_LISTENING`, `API_STOPPED`, `API_SHUTDOWN_FAILED`, `API_START_FAILED`).

---

## 3. Asynchronous Context Propagation & Correlation

### HTTP Path
1. `createHttpSecurityLoggingMiddleware` reads incoming `x-correlation-id` or `x-request-id` headers and validates them against `/^[A-Za-z0-9._-]{8,64}$/`. Unsafe, empty, oversized, or control-character/CRLF inputs are discarded and replaced with a fresh `randomUUID()` (UUID v4) to prevent log forging.
2. The validated ID is echoed on the `x-correlation-id` response header and bound to a per-request `AsyncLocalStorage` store (`service: 'omnihub-api'`, `component: 'http'`).
3. When `authenticate(...)` or `login(...)` succeeds in [`apps/api/src/auth.ts`](../apps/api/src/auth.ts), `updateLogContext({ tenantId, storeId, userId })` enriches the active request store.
4. On response `finish`, `HTTP_ACCESS` executes inside the captured `requestContext` so `tenantId`, `storeId`, `userId`, and sanitized `path` are emitted reliably without manual parameter threading through domain services.
5. `pilot-admin.ts#acceptInvitation` falls back to `getLogContext()?.correlationId ?? ''` when no explicit correlation ID is supplied so HTTP `Audit` records preserve the request correlation ID.

### Background Outbox Worker Path
- In [`apps/api/src/outbox.ts`](../apps/api/src/outbox.ts), each `loop.step()` polling cycle runs inside `runWithLogContext({ correlationId: randomUUID(), service: 'omnihub-worker', component: 'outbox-worker', jobName: 'outbox-batch', batchId: randomUUID() }, ...)`.
- Batch retry/recovery logs automatically inherit `jobName` and `batchId`, while per-event logs (`OUTBOX_PUBLISHED`, `OUTBOX_EVENT_INVALID`) explicitly pass `correlationId: row.correlationId` so operators can trace a single order mutation end-to-end from HTTP ingress through transactional outbox publication.

---

## 4. Security Redaction & Sanitization

Sanitization combines key-based denylisting, pattern scrubbing, object normalization, and optional per-logger field allowlisting:

1. **Key-based denylist (`isSensitiveFieldName`):** Any field name matching exact sensitive keys (`pass`, `pan`, `pin`, `otp`, `auth`, `session`, `key`) or containing sensitive substrings (`password`, `passwd`, `secret`, `token`, `cookie`, `authorization`, `credential`, `privatekey`, `apikey`, `signature`, `hmac`, `cvv`, `cardnumber`, `connectionstring`, `databaseurl`, `redisurl`, `rawbody`) is replaced recursively with `"[REDACTED]"`.
2. **Optional field allowlist (`allowedFields`):** Security-sensitive or high-volume child loggers can specify `allowedFields`; non-envelope keys outside the allowlist are omitted before serialization while allowlisted values still undergo full denylist and string scrubbing.
3. **String scrubbing (`scrubSensitiveString`):**
   - Fields named `path`, `url`, or `originalUrl` pass through `accessLogPath(...)`, stripping query strings and masking `/public/qr/<credential>` segments as `/public/qr/:credential`.
   - Inline credentials (`URL` `user:pass@`, `Bearer ...`, `session=`/`token=` cookie pairs, 64-character hex tokens, high-confidence token prefixes, PEM private key headers) are redacted.
   - Login failures in [`apps/api/src/auth.ts`](../apps/api/src/auth.ts) log a non-reversible `emailHashPrefix` (`16` hex characters) instead of plaintext email addresses.
4. **Safe value normalization (`sanitizeLogValue`):** `Error` objects normalize strictly to `{ errorType: error.name }` (omitting stacks and arbitrary error messages), circular references normalize to `"[Circular]"`, objects deeper than depth `6` stop at `"[MaxDepth]"`, `BigInt` serializes as a string, and `Date` validates via `toISOString()`.

---

## 5. Log Levels, Performance, Fault Isolation & Graceful Shutdown

- **Dynamic level filtering (`LOG_LEVEL`):** `resolveLogLevel(process.env.LOG_LEVEL)` defaults to `'info'`. Records below the active threshold return immediately on line 1 of `StructuredLogger.log(...)` before calling `getLogContext()`, allocating `LogRecord`, running recursive sanitization, or calling `JSON.stringify`.
- **Non-throwing guarantee:** Serialization or `sink.write` failures (sync or async) are caught internally, counted via `getFailureCount()`, routed to `onWriteError` or a minimal JSON `LOGGING_WRITE_FAILED` fallback on `process.stderr`, and **never** propagate exceptions into HTTP handlers or outbox transactions.
- **Graceful shutdown:** Both [`apps/api/src/main.ts`](../apps/api/src/main.ts) and [`apps/api/src/worker.ts`](../apps/api/src/worker.ts) await `apiLogger.close()` / `workerLogger.close()` on exit (`SIGINT`, `SIGTERM`, clean stop, or fatal startup abort), flushing any pending asynchronous sink writes before exit and ignoring post-close log calls.
