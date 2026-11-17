# Realtime architecture and recovery

PostgreSQL is authoritative. Operational mutations append an audit row, idempotency receipt and outbox event in the same serializable transaction. Each API replica attaches Socket.IO with `@socket.io/redis-adapter` (key prefix `omnihub:socket.io`, separate wrapped `adapter_pub` and `adapter_sub` Redis connections) alongside a dedicated resilient `events_sub` subscriber on `omnihub.events`. Note that HTTP long-polling Engine.IO handshakes require reverse-proxy session affinity or direct WebSocket transport when scaling behind a load balancer, while `@socket.io/redis-adapter` coordinates multi-replica rooms, broadcasts, and disconnect fan-out cleanly under least-privilege Redis ACLs ([redis-start.sh](../deploy/redis-start.sh)). The worker ([worker.ts](../apps/api/src/worker.ts), [outbox.ts](../apps/api/src/outbox.ts)) claims undelivered outbox records with PostgreSQL `FOR UPDATE SKIP LOCKED` in creation order, validates event schemas, enforces per-event timeouts (`5s` default) and a bounded batch budget (`10s` inside a `15s` transaction deadline), commits partial `deliveredAt` updates before timeout, and backs off cleanly on Redis failures. On `events_sub` delivery, API replicas inspect only local room sockets via `io.local`, deduplicate concurrent and redelivered `eventId`s via an in-flight map plus bounded FIFO cache (`MAX_SEEN_EVENT_IDS = 2048`), and clients refresh authorized REST projections instead of treating socket events as state.

Employee sockets decode the HttpOnly session cookie, store only the SHA-256 `tokenHash` in `socket.data` (never raw session tokens), join only the authenticated tenant/store room, and revalidate session, membership, kitchen device state and server-assigned room via batched PostgreSQL queries during broadcasts (`broadcastOperationalEvent`), subscriber reconnect recovery, and 30-second periodic checks (`revalidateRealtimeSockets`). `POST /auth/logout`, `PUT /admin/kitchen/devices/:id/assignment`, and `POST /admin/kitchen/devices/:id/revoke` atomically persist `session.revoked` / `kitchen.device.changed` outbox rows inside PostgreSQL and trigger best-effort post-commit `publishRealtimeOperationalEvent` so affected sockets across all replicas disconnect immediately while non-revoked sessions remain unaffected and other store staff never receive session-revocation disclosures. Customer tracking sockets validate per-order capabilities strictly and receive only an order-update signal. Clients cannot choose rooms or custom namespaces.

Redis Pub/Sub is transient, so delivery is not an event-history guarantee. `/ready` executes PostgreSQL `SELECT 1`, Redis rate-limiter `PING`, and `realtimeRedisReady()`—returning `503 REDIS_REQUIRED_FOR_REALTIME` until `events_sub`, `adapter_pub`, `adapter_sub`, and all required `subscribe`/`psubscribe` confirmations are genuinely ready without ACL (`NOPERM`) denials. Redis disconnect/ACL errors are logged via structured JSON (`REALTIME_REDIS_UNAVAILABLE`, `REALTIME_ADAPTER_SUBSCRIPTION_FAILED`, `REALTIME_ADAPTER_PUBLISH_FAILED`), metered in Prometheus (`realtime_adapter_ready`, `realtime_adapter_errors_total`, `realtime_revocations_total`), and never crash the Node process with unhandled rejections. When Redis recovers after a disconnect, `events_sub` automatically re-subscribes and runs `revalidateRealtimeSockets` so no revocations missed during the outage survive.

## Local Redis recovery

With Docker Engine running, check current containers before acting:

```powershell
docker compose ps
docker compose up -d --wait redis
docker compose exec redis redis-cli ping
```

Expected Redis response is `PONG`. Then run `pnpm worker` in a separate terminal and start the API. For the realtime browser assertion, launch the web/API and run:

```powershell
pnpm.cmd exec playwright test tests/e2e/workflow.spec.ts -g realtime
```

The test must see an accepted order on a second kitchen browser before the 15-second polling fallback. A polling refresh does not pass that assertion. To test reconnect recovery, start clients/API/worker with Redis available, stop only the Redis service without deleting volumes, commit an order, restore Redis, and verify the connected clients fetch current database state. Do not use `docker compose down -v` for recovery drills.

Current environment evidence is recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). A running Docker CLI alone is insufficient: Engine connectivity and an actual `PONG` are required before marking Redis tests verified.

Device sessions use the normal HttpOnly employee cookie plus a non-secret device identifier. Offline IndexedDB contains a scoped identifier and command queue, never a bearer session token. The server checks current membership, device revocation and station assignment during sync and Socket.IO delivery. Redis outages do not authorize queued commands; the API still validates each command against PostgreSQL.
