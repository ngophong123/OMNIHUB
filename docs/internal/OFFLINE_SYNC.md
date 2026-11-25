# Offline-first kitchen operation

The offline scope is deliberately limited to already loaded kitchen tickets and two kitchen transitions: `START` and item `READY`. Offline mode does not accept orders, mark handoff, cancel orders, receive inventory, or confirm payments. New server orders cannot be received while disconnected. PostgreSQL remains authoritative.

## Local storage

The KDS registers `/sw.js` and installs as a PWA from `/manifest.webmanifest`. The service worker caches the application shell and versioned Next static assets, never API responses. IndexedDB (`omnihub-kitchen-v1`) stores:

- A minimal order/ticket snapshot partitioned by tenant, store and user. It excludes prices, payments, refunds, employee data and authentication credentials.
- A durable command queue partitioned by the same scope. Each record contains command UUID, tenant/store/user scope, a non-secret device UUID, order/item IDs, expected order version, `START`/`READY`, monotonically allocated device sequence, creation time and sync status.
- A device UUID and local sequence counter. The UUID is not a credential; the API registers it under the authenticated user/store and can revoke it. Session cookies remain HttpOnly and are never placed in IndexedDB.

The KDS writes a command in an IndexedDB read/write transaction before rendering its optimistic state. On browser restart, `SENDING` commands return to `PENDING`. Scope changes isolate records. Explicit logout clears the cached identity and ticket snapshot; queued commands remain in their original user/store partition and cannot be replayed under another identity.

## Synchronization and conflicts

When reconnecting, the client verifies `/auth/me`, registers/revalidates the device, fetches authoritative orders, then replays commands in device sequence. The API validates session and membership, device scope/revocation, store scope, command age, item/order binding, action allowlist and exact expected order version. It delegates each mutation to the existing serializable `Operations.item` transaction with `commandId` as the idempotency key. This retains existing authorization, stock consumption, audit, outbox and receipt behavior; retrying a committed command returns its receipt and does not consume inventory twice.

A version or transition conflict stops later commands for that order. The server returns `CONFLICT`; dependent commands are returned `BLOCKED`. The browser preserves those records and shows a review panel. A staff member can acknowledge the conflict, which marks it `REVIEWED` without rewriting server state. There is no last-write-wins or silent rebase. After replay, the KDS fetches PostgreSQL state again. Transient failures leave commands pending, and the user can retry. The browser does not rely on Background Sync support.

The server refuses replay timestamps over five minutes in the future or older than 30 days. Command IDs are UUIDv4 and deduplicated by the existing command receipt table. Device UUIDs are metadata only; every registration and replay still requires the current HttpOnly authenticated session.

## Retention and recovery

Only the current scoped ticket snapshot and command history are stored. Logout removes cached tickets and identity; it retains queued commands for that partition to avoid silently discarding work. Use the conflict panel before changing users on a shared kitchen device. Browser/profile deletion removes local unsynchronized work; a staff member should verify the server state before clearing browser data. There is no remote cache wipe or backup of offline commands.

Socket.IO operational events trigger authoritative refresh and queue reconciliation. A 15-second REST fallback and browser `online` event do the same. If Redis is unavailable, tickets and commands continue to work after reconnect by polling; push delivery is not claimed. See [realtime architecture](REALTIME_ARCHITECTURE.md).

## Verified scope

Implementation and test evidence are tracked separately in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and [TESTING.md](TESTING.md). Network-disconnect Playwright tests are required to verify persistence through reload and reconciliation; code compilation alone is not evidence. POS/order acceptance, inventory writes, payment, refund and handoff remain online-only.
