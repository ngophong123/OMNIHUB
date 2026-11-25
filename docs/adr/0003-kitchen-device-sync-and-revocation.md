# ADR-0003: Kitchen Device Sync Isolation and Revocation Concurrency

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Kitchen display tablets run as an offline-capable PWA that registers a `KitchenDevice` record, sends periodic heartbeats (`POST /kitchen/devices/register`), and replays queued `START`/`READY` commands on reconnect (`POST /kitchen/sync`). Simultaneously, an owner or manager may reassign the device's station or revoke the device (`POST /admin/kitchen/devices/:id/revoke`). Running heartbeats in `Serializable` transactions caused bursts of PostgreSQL `P2034` serialization aborts when multiple heartbeats raced with revocation, while naive `lastSeenAt` updates risked confirming commands for a concurrently revoked device.

## Decision

1. Keep initial device creation, station assignment, and revocation inside `Serializable` transactions wrapped by `runSerializableTransactionWithRetry`, emitting `Audit` and `Outbox` (`kitchen.device.changed`) rows in the same commit and triggering immediate best-effort socket disconnect.
2. Execute steady-state device heartbeats via an atomic conditional `ReadCommitted` update (`UPDATE "KitchenDevice" SET "lastSeenAt" = now() WHERE id = $1 AND tenantId = $2 AND storeId = $3 AND userId = $4 AND revokedAt IS NULL`). Under PostgreSQL `EvalPlanQual`, concurrent heartbeats wait on the row lock and re-evaluate `revokedAt IS NULL` without throwing `P2034`, immediately returning `403` if a revocation committed first.
3. On `POST /kitchen/sync`, verify `updateMany` (`count === 1` with `revokedAt IS NULL`) before processing commands, and lock the active `KitchenDevice` row `FOR SHARE` inside each `Serializable` item command transaction (`apps/api/src/operations.ts`) so no command can commit after or across a revocation boundary.
4. On offline command version conflicts, stop per-order replay and return `CONFLICT`/`BLOCKED` rather than applying last-write-wins.

## Consequences

- **Positive:** Eliminates `P2034` retry exhaustion under concurrent heartbeat bursts while strictly blocking revoked devices from registering, syncing, or mutating kitchen items; prevents duplicate audit/outbox rows on revocation races.
- **Trade-offs:** Adds a `FOR SHARE` lock on `KitchenDevice` during kitchen item mutations and requires explicit conflict-queue UI handling when offline commands diverge from server order versions.
