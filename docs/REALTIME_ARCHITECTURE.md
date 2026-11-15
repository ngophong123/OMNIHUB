# Realtime architecture and recovery

PostgreSQL is authoritative. Operational mutations append an audit row, idempotency receipt and outbox event in the same serializable transaction. The API Socket.IO gateway ([realtime.ts](../apps/api/src/realtime.ts)) and worker ([worker.ts](../apps/api/src/worker.ts), [outbox.ts](../apps/api/src/outbox.ts)) independently subscribe/publish through Redis Pub/Sub on `omnihub.events`. The worker claims undelivered outbox records with PostgreSQL `FOR UPDATE SKIP LOCKED` in creation order, validates event schemas (quarantining permanently malformed rows without halting valid events), enforces both per-event publish timeouts (`5s` default) and a bounded per-batch time budget (`10s` default inside a `15s` transaction deadline with `5s` commit headroom), commits already-published `deliveredAt` updates before transaction expiration or on mid-batch transient errors, leaves unprocessed rows pending for immediate continuation under at-least-once delivery semantics, backs off with bounded exponential jitter on Redis failures, and awaits any active batch cleanly on shutdown. Events are invalidation signals; clients refresh authorized REST projections instead of treating a socket payload as state.

Employee sockets safely decode the HttpOnly session cookie, join only the authenticated tenant/store room and revalidate session, membership, kitchen device state and server-assigned room via batched PostgreSQL queries during broadcasts (`broadcastOperationalEvent`) and 30-second periodic checks (`revalidateRealtimeSockets`), eliminating per-socket N+1 queries and disconnecting drifted or revoked clients immediately. Customer tracking sockets validate per-order capabilities strictly and receive only an order-update signal. Clients cannot pick a room. The KDS reconnect path revalidates `/auth/me`, reloads authoritative tickets, replays scoped versioned kitchen commands and refreshes again.

Redis Pub/Sub is transient, so delivery is not an event-history guarantee. If a subscriber is offline during publish, the committed database change is recovered by the client REST polling/reconnect path. The worker keeps retrying while Redis is unavailable. Protected public/authentication routes fail closed with HTTP 503 when shared Redis rate limiting cannot run; ordinary store transactions continue to use PostgreSQL. `/ready` checks PostgreSQL and Redis PING because both are required for protected ingress. It does not prove worker subscription or end-to-end Socket.IO delivery; the two-browser E2E remains the proof for that path.

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
