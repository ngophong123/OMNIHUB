# ADR-0002: Transactional Outbox with Redis Pub/Sub and Socket.IO Adapter

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

Staff POS terminals, kitchen displays, and customer QR tracking views need low-latency updates when orders, tickets, or revocations change. Publishing directly to Redis or Socket.IO inside a business request risks dual-write divergence (events emitted for rolled-back transactions, or committed transactions missing notifications) and breaks when multiple API replicas serve connected sockets.

## Decision

1. Write `Outbox` event rows inside the same PostgreSQL transaction as every domain mutation, with zero network calls inside business transactions.
2. Run a standalone worker (`apps/api/src/worker.ts`) that polls undelivered rows with `FOR UPDATE SKIP LOCKED`, enforces a bounded batch time budget (`10s` inside a `15s` transaction timeout), commits partial progress cleanly, and publishes events to Redis Pub/Sub (`omnihub.events`) with at-least-once delivery.
3. Attach `@socket.io/redis-adapter` on API replicas (`apps/api/src/realtime.ts`), deduplicate redelivered `eventId`s using a bounded FIFO cache (`MAX_SEEN_EVENT_IDS = 2048`), and scope broadcasts to server-controlled `(tenantId, storeId)` or order-tracking rooms.
4. Treat Socket.IO messages strictly as cache invalidation signals; clients re-fetch authoritative REST projections on events, reconnects, and periodic intervals.

## Consequences

- **Positive:** Redis or worker outages never roll back committed PostgreSQL orders; multi-replica API instances fan out events and disconnect revoked sessions/devices consistently; duplicate deliveries are harmless.
- **Trade-offs:** Requires running an additional worker process alongside the API and monitoring outbox lag. Redis Pub/Sub provides no end-to-end browser delivery acknowledgement, so REST re-synchronization remains mandatory.
