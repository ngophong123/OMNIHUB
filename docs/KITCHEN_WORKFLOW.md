# Kitchen workflow

One ticket per station per order, with multiple physical unit items. Ticket status is computed, not independently writable: all cancelled -> CANCELLED; all terminal -> FINISHED; any PREPARING/READY/HANDED_OFF -> IN_PROGRESS; otherwise PENDING. READY and HANDED_OFF remain distinct item states. Kitchen readiness can be derived when all noncancelled units are READY/HANDED_OFF; handoff is fulfillment.

START consumes ingredients in the same transaction as state transition. READY never consumes a second time. Server timestamps determine waiting/preparation durations; clients display them without creating authoritative times. Version at order aggregate serializes concurrent item/payment/cancellation commands; stale version requires refresh. All stations currently require membership of the same store. Per-station staff ACL is deferred and explicitly not claimed.

Realtime is cache invalidation with authoritative REST resync. Initial fetch, reconnect fetch and periodic refresh repair missed notifications. Showing a ticket is not an acknowledgement that it was physically prepared. Sounds, configurable SLA/escalation, touch optimizations, and richer station filtering remain pilot UX work.
