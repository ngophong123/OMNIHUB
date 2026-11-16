import { eventTypes } from '@omnihub/contracts';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { accessLogPath } from '../deployment-security';
import { apiLogger } from './logger';

export const DEFAULT_OUTBOX_BACKLOG_CACHE_TTL_MS = 5_000;
export const DEFAULT_HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
export const DEFAULT_OUTBOX_BATCH_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15] as const;

const KNOWN_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const KNOWN_COMMAND_OPERATIONS = new Set<string>(eventTypes);
const KNOWN_ERROR_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'ROUTE_NOT_FOUND',
  'ORIGIN_DENIED',
  'RATE_LIMITED',
  'RATE_LIMITER_UNAVAILABLE',
  'METRICS_ACCESS_DENIED',
  'INVALID_INPUT',
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'SERVICE_UNAVAILABLE',
  'BAD_REQUEST',
  'DB_UNAVAILABLE',
  'DUPLICATE_RECORD',
  'CONCURRENT_CHANGE_RETRY_SAME_KEY',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_UUID_V4_REQUIRED',
  'INVALID_CREDENTIALS',
  'SESSION_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'MEMBERSHIP_REQUIRED',
]);

const STATIC_ROUTE_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/health$/, '/health'],
  [/^\/ready$/, '/ready'],
  [/^\/metrics$/, '/metrics'],
  [/^\/auth\/login$/, '/auth/login'],
  [/^\/auth\/me$/, '/auth/me'],
  [/^\/auth\/logout$/, '/auth/logout'],
  [/^\/public\/table-sessions\/orders$/, '/public/table-sessions/orders'],
  [/^\/public\/table-sessions\/me$/, '/public/table-sessions/me'],
  [/^\/public\/qr\/:credential\/menu$/, '/public/qr/:credential/menu'],
  [/^\/public\/qr\/:credential\/session$/, '/public/qr/:credential/session'],
  [/^\/public\/qr\/:credential(?:\/.*)?$/, '/public/qr/:credential'],
  [/^\/public\/order-status\/:trackingToken$/, '/public/order-status/:trackingToken'],
  [/^\/public\/invitations\/:token\/accept$/, '/public/invitations/:token/accept'],
  [/^\/public(?:\/.*)?$/, '/public/*'],
  [/^\/webhooks(?:\/.*)?$/, '/webhooks/*'],
  [/^\/orders(?:\/.*)?$/, '/orders/*'],
  [/^\/catalog(?:\/.*)?$/, '/catalog'],
  [/^\/inventory(?:\/.*)?$/, '/inventory/*'],
  [/^\/cash(?:\/.*)?$/, '/cash/*'],
  [/^\/reports(?:\/.*)?$/, '/reports/*'],
  [/^\/admin(?:\/.*)?$/, '/admin/*'],
];

const DISCONNECT_REASON_MAP: Readonly<Record<string, string>> = {
  'client namespace disconnect': 'client_disconnect',
  'server namespace disconnect': 'server_disconnect',
  'transport close': 'transport_close',
  'transport error': 'transport_error',
  'ping timeout': 'ping_timeout',
  'forced close': 'forced_close',
  'parse error': 'parse_error',
};

let defaultMetricsInitialized = false;

export type OutboxBacklogReader = {
  outbox: {
    count(args: { where: { deliveredAt: null } }): Promise<number>;
    findFirst(args: {
      where: { deliveredAt: null };
      orderBy: { createdAt: 'asc' };
      select: { createdAt: true };
    }): Promise<{ createdAt: Date } | null>;
  };
};

export type MetricsRegistryOptions = {
  service?: string;
  collectDefaultMetrics?: boolean;
  outboxBacklogCacheTtlMs?: number;
};

export function normalizeHttpMethod(method?: string): string {
  const upper = method?.trim().toUpperCase() ?? '';
  return KNOWN_HTTP_METHODS.has(upper) ? upper : 'OTHER';
}

export function normalizeStatusClass(statusCode: number): string {
  if (!Number.isFinite(statusCode) || statusCode < 100 || statusCode >= 600) return 'other';
  const group = Math.floor(statusCode / 100);
  if (group === 2) return '2xx';
  if (group === 3) return '3xx';
  if (group === 4) return '4xx';
  if (group === 5) return '5xx';
  return 'other';
}

/** Normalizes HTTP paths into a strictly bounded set of route templates to prevent cardinality explosion. */
export function normalizeHttpRouteLabel(routePath?: unknown, originalUrl?: string): string {
  if (typeof routePath === 'string' && routePath.length > 0) {
    const cleaned = routePath.startsWith('/') ? routePath : `/${routePath}`;
    if (/^\/[a-zA-Z0-9/:_-]*$/.test(cleaned) && cleaned.length <= 80) {
      return cleaned;
    }
  }
  const maskedPath = accessLogPath((originalUrl ?? '/').split('?')[0] ?? '/').toLowerCase();
  const normalized = maskedPath.length > 1 && maskedPath.endsWith('/') ? maskedPath.slice(0, -1) : maskedPath;
  for (const [pattern, label] of STATIC_ROUTE_PREFIXES) {
    if (pattern.test(normalized)) return label;
  }
  return 'unmatched';
}

export function normalizeErrorCodeLabel(code?: string): string {
  if (!code) return 'OTHER_ERROR';
  const upper = code.trim().toUpperCase();
  return KNOWN_ERROR_CODES.has(upper) ? upper : 'OTHER_ERROR';
}

export function normalizeRateLimitPrefix(prefix: string): string {
  const sanitized = prefix.trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '_').slice(0, 32);
  return sanitized || 'other';
}

export function normalizeCommandOperation(operation: string): string {
  return KNOWN_COMMAND_OPERATIONS.has(operation) ? operation : 'other';
}

export function normalizeDbErrorCode(code: string): string {
  const trimmed = code.trim().toUpperCase();
  if (trimmed === 'P2024') return 'p2024_pool_timeout';
  if (trimmed === 'P2034') return 'p2034_serialization';
  if (trimmed === 'P2002') return 'p2002_unique';
  if (trimmed === 'DB_UNAVAILABLE' || trimmed.startsWith('P10')) return 'db_unavailable';
  return 'prisma_other';
}

export function normalizeDisconnectReason(reason?: string): string {
  if (!reason) return 'other';
  return DISCONNECT_REASON_MAP[reason] ?? 'other';
}

export type MetricsCollector = ReturnType<typeof createMetricsRegistry>;

/**
 * Creates an isolated Prometheus metrics registry with finite low-cardinality labels,
 * cached outbox backlog querying, and clean lifecycle teardown.
 */
export function createMetricsRegistry(options: MetricsRegistryOptions = {}) {
  const registry = new Registry();
  if (options.service) {
    registry.setDefaultLabels({ service: options.service });
  }
  if (options.collectDefaultMetrics && !defaultMetricsInitialized) {
    // Guard Node GC / event-loop PerformanceObservers so default metrics never attach duplicate global observers.
    defaultMetricsInitialized = true;
    collectDefaultMetrics({ register: registry });
  }

  const outboxBacklogCacheTtlMs = Math.max(0, options.outboxBacklogCacheTtlMs ?? DEFAULT_OUTBOX_BACKLOG_CACHE_TTL_MS);
  let closed = false;
  let lastBacklogRefreshAt = 0;
  let backlogRefreshInFlight: Promise<void> | null = null;

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total completed HTTP requests partitioned by method, bounded route pattern, and status class.',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency distribution in seconds.',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [...DEFAULT_HTTP_DURATION_BUCKETS],
    registers: [registry],
  });

  const httpRequestsInFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'Number of HTTP requests currently being processed.',
    labelNames: ['method'] as const,
    registers: [registry],
  });

  const httpErrorsTotal = new Counter({
    name: 'http_errors_total',
    help: 'Total HTTP error responses partitioned by method, bounded route, and error code.',
    labelNames: ['method', 'route', 'code'] as const,
    registers: [registry],
  });

  const rateLimitDecisionsTotal = new Counter({
    name: 'rate_limit_decisions_total',
    help: 'Total rate limiter decisions partitioned by rule prefix and outcome.',
    labelNames: ['prefix', 'outcome'] as const,
    registers: [registry],
  });

  const commandBusAttemptsTotal = new Counter({
    name: 'command_bus_attempts_total',
    help: 'Total CommandBus execution attempts and outcomes partitioned by domain operation.',
    labelNames: ['operation', 'outcome'] as const,
    registers: [registry],
  });

  const dbTransactionRetriesTotal = new Counter({
    name: 'db_transaction_retries_total',
    help: 'Total Serializable transaction retries triggered by serialization/transient PostgreSQL conflicts.',
    labelNames: ['operation', 'reason'] as const,
    registers: [registry],
  });

  const dbErrorsTotal = new Counter({
    name: 'db_errors_total',
    help: 'Total database errors classified by bounded Prisma/connectivity category.',
    labelNames: ['code'] as const,
    registers: [registry],
  });

  const outboxPendingCount = new Gauge({
    name: 'outbox_pending_count',
    help: 'Current number of undelivered outbox rows waiting to be published.',
    registers: [registry],
  });

  const outboxOldestPendingAgeSeconds = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Age in seconds of the oldest undelivered outbox event.',
    registers: [registry],
  });

  const outboxDeadLetterTotal = new Gauge({
    name: 'outbox_dead_letter_total',
    help: 'Current count of malformed outbox events quarantined in worker memory.',
    registers: [registry],
  });

  const outboxQuarantinedEventsTotal = new Counter({
    name: 'outbox_quarantined_events_total',
    help: 'Cumulative count of malformed outbox events quarantined during processing.',
    registers: [registry],
  });

  const outboxEventsTotal = new Counter({
    name: 'outbox_events_total',
    help: 'Cumulative outbox event processing outcomes partitioned by outcome.',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const outboxBatchDurationSeconds = new Histogram({
    name: 'outbox_batch_duration_seconds',
    help: 'Duration in seconds of outbox polling/publishing batches.',
    labelNames: ['outcome'] as const,
    buckets: [...DEFAULT_OUTBOX_BATCH_BUCKETS],
    registers: [registry],
  });

  const outboxWorkerHealth = new Gauge({
    name: 'outbox_worker_health',
    help: 'Outbox worker loop health indicator (1 = healthy, 0 = degraded or stopped).',
    registers: [registry],
  });

  const outboxWorkerConsecutiveFailures = new Gauge({
    name: 'outbox_worker_consecutive_failures',
    help: 'Current consecutive failed polling iterations in the outbox worker.',
    registers: [registry],
  });

  const realtimeConnectedSockets = new Gauge({
    name: 'realtime_connected_sockets',
    help: 'Current number of authenticated Socket.IO connections attached to this API instance.',
    registers: [registry],
  });

  const realtimeConnectionsTotal = new Counter({
    name: 'realtime_connections_total',
    help: 'Cumulative Socket.IO handshake attempts partitioned by acceptance outcome.',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const realtimeDisconnectsTotal = new Counter({
    name: 'realtime_disconnects_total',
    help: 'Cumulative Socket.IO disconnections partitioned by normalized reason.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const realtimeEventsBroadcastTotal = new Counter({
    name: 'realtime_events_broadcast_total',
    help: 'Cumulative Redis-to-Socket.IO operational event broadcast outcomes.',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  return {
    registry,
    get contentType() {
      return registry.contentType;
    },
    isClosed() {
      return closed;
    },
    recordHttpRequestStart(method?: string): () => void {
      if (closed) return () => undefined;
      const m = normalizeHttpMethod(method);
      httpRequestsInFlight.inc({ method: m }, 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (!closed) httpRequestsInFlight.dec({ method: m }, 1);
      };
    },
    recordHttpRequest(params: {
      method?: string;
      routePath?: unknown;
      originalUrl?: string;
      statusCode: number;
      durationSeconds: number;
    }): void {
      if (closed) return;
      const labels = {
        method: normalizeHttpMethod(params.method),
        route: normalizeHttpRouteLabel(params.routePath, params.originalUrl),
        status_class: normalizeStatusClass(params.statusCode),
      };
      httpRequestsTotal.inc(labels, 1);
      const duration = Number.isFinite(params.durationSeconds) && params.durationSeconds >= 0 ? params.durationSeconds : 0;
      httpRequestDurationSeconds.observe(labels, duration);
    },
    recordHttpError(params: { method?: string; routePath?: unknown; originalUrl?: string; code?: string }): void {
      if (closed) return;
      httpErrorsTotal.inc({
        method: normalizeHttpMethod(params.method),
        route: normalizeHttpRouteLabel(params.routePath, params.originalUrl),
        code: normalizeErrorCodeLabel(params.code),
      }, 1);
    },
    recordRateLimitDecision(prefix: string, outcome: 'allowed' | 'blocked_429' | 'unavailable_503'): void {
      if (closed) return;
      rateLimitDecisionsTotal.inc({ prefix: normalizeRateLimitPrefix(prefix), outcome }, 1);
    },
    recordCommandBusAttempt(
      operation: string,
      outcome: 'success' | 'idempotent_replay' | 'retry_p2034' | 'retry_p2002' | 'retry_transient' | 'conflict_exhausted' | 'error',
    ): void {
      if (closed) return;
      commandBusAttemptsTotal.inc({ operation: normalizeCommandOperation(operation), outcome }, 1);
    },
    recordDbRetry(operation: string, reason: 'p2034_serialization' | 'p2002_unique' | 'pg_transient_retry'): void {
      if (closed) return;
      dbTransactionRetriesTotal.inc({ operation: normalizeCommandOperation(operation), reason }, 1);
    },
    recordDbError(code: string): void {
      if (closed) return;
      dbErrorsTotal.inc({ code: normalizeDbErrorCode(code) }, 1);
    },
    setOutboxBacklog(pendingCount: number, oldestPendingAgeSeconds: number): void {
      if (closed) return;
      outboxPendingCount.set(Math.max(0, pendingCount));
      outboxOldestPendingAgeSeconds.set(Math.max(0, oldestPendingAgeSeconds));
    },
    recordOutboxPublished(count = 1): void {
      if (closed || count <= 0) return;
      outboxEventsTotal.inc({ outcome: 'published' }, count);
    },
    recordOutboxFailed(count = 1): void {
      if (closed || count <= 0) return;
      outboxEventsTotal.inc({ outcome: 'failed' }, count);
    },
    recordOutboxQuarantined(currentQuarantinedSize: number, newlyQuarantined = 0): void {
      if (closed) return;
      outboxDeadLetterTotal.set(Math.max(0, currentQuarantinedSize));
      if (newlyQuarantined > 0) {
        outboxQuarantinedEventsTotal.inc(newlyQuarantined);
        outboxEventsTotal.inc({ outcome: 'invalid_quarantined' }, newlyQuarantined);
      }
    },
    recordOutboxBatchDuration(outcome: 'ok' | 'degraded' | 'budget_exceeded' | 'error', durationSeconds: number): void {
      if (closed) return;
      const duration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;
      outboxBatchDurationSeconds.observe({ outcome }, duration);
    },
    setOutboxWorkerHealth(healthy: boolean, consecutiveFailures: number): void {
      if (closed) return;
      outboxWorkerHealth.set(healthy ? 1 : 0);
      outboxWorkerConsecutiveFailures.set(Math.max(0, consecutiveFailures));
    },
    setRealtimeConnectedSockets(count: number): void {
      if (closed) return;
      realtimeConnectedSockets.set(Math.max(0, count));
    },
    recordRealtimeConnection(accepted: boolean): void {
      if (closed) return;
      realtimeConnectionsTotal.inc({ outcome: accepted ? 'accepted' : 'rejected' }, 1);
    },
    recordRealtimeDisconnect(reason?: string): void {
      if (closed) return;
      realtimeDisconnectsTotal.inc({ reason: normalizeDisconnectReason(reason) }, 1);
    },
    recordRealtimeBroadcast(outcome: 'broadcast' | 'invalid_payload' | 'error'): void {
      if (closed) return;
      realtimeEventsBroadcastTotal.inc({ outcome }, 1);
    },
    async refreshOutboxBacklog(db: OutboxBacklogReader, nowMs: () => number = () => Date.now()): Promise<void> {
      if (closed) return;
      const current = nowMs();
      if (lastBacklogRefreshAt > 0 && current - lastBacklogRefreshAt < outboxBacklogCacheTtlMs) {
        return;
      }
      if (backlogRefreshInFlight) {
        await backlogRefreshInFlight;
        return;
      }
      backlogRefreshInFlight = (async () => {
        try {
          const [pending, oldest] = await Promise.all([
            db.outbox.count({ where: { deliveredAt: null } }),
            db.outbox.findFirst({
              where: { deliveredAt: null },
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            }),
          ]);
          const refTime = nowMs();
          const ageSeconds = oldest ? Math.max(0, (refTime - oldest.createdAt.getTime()) / 1000) : 0;
          if (!closed) {
            outboxPendingCount.set(Math.max(0, pending));
            outboxOldestPendingAgeSeconds.set(ageSeconds);
            lastBacklogRefreshAt = refTime;
          }
        } catch (err) {
          if (!closed) {
            dbErrorsTotal.inc({ code: 'db_unavailable' }, 1);
            apiLogger.ops('warn', 'METRICS_OUTBOX_REFRESH_FAILED', {
              component: 'metrics',
              errorType: err instanceof Error ? err.name : typeof err,
            });
          }
        } finally {
          backlogRefreshInFlight = null;
        }
      })();
      await backlogRefreshInFlight;
    },
    async render(): Promise<string> {
      if (closed) return '';
      return registry.metrics();
    },
    close(): void {
      if (closed) return;
      closed = true;
      backlogRefreshInFlight = null;
      lastBacklogRefreshAt = 0;
      registry.clear();
    },
  };
}

export const apiMetrics = createMetricsRegistry({
  service: 'omnihub-api',
  collectDefaultMetrics: !process.env.VITEST,
});

export const workerMetrics = createMetricsRegistry({
  service: 'omnihub-worker',
  collectDefaultMetrics: !process.env.VITEST,
});
