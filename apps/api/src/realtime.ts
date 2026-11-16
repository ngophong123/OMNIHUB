import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type RedisOptions } from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { eventSchema, type OperationalEvent } from '@omnihub/contracts';
import { digest } from './domain';
import { authenticate } from './auth';
import { db } from './database';
import { apiLogger } from './observability/logger';
import { apiMetrics, type MetricsCollector } from './observability/metrics';

const TRACKING_TOKEN_RE = /^[a-f0-9]{64}$/i;
const SESSION_TOKEN_RE = /^[a-f0-9]{64}$/i;
const DEVICE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_REALTIME_ADAPTER_KEY = 'omnihub:socket.io';
export const DEFAULT_OUTBOX_CHANNEL = 'omnihub.events';
export const MAX_SEEN_EVENT_IDS = 2_048;

const CUSTOMER_ORDER_EVENTS = new Set([
  'order.accepted',
  'order.cancelled',
  'order.item.cancelled',
  'kitchen.item.started',
  'kitchen.item.ready',
  'kitchen.item.handed_off',
]);

const REVOCATION_ONLY_EVENTS = new Set<string>(['session.revoked']);

export type RealtimeSocketLike = {
  id?: string;
  data: Record<string, unknown>;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(close?: boolean): unknown;
};

export type RealtimeScopedServerLike = {
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
  in(room: string): { fetchSockets(): Promise<RealtimeSocketLike[]> };
};

export type RealtimeServerLike = RealtimeScopedServerLike & {
  local?: RealtimeScopedServerLike;
  sockets?: { sockets: { values(): IterableIterator<RealtimeSocketLike> } };
};

export type RealtimeRedisLike = {
  status?: string;
  isCluster?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  subscribe(...args: unknown[]): Promise<unknown>;
  unsubscribe(...args: unknown[]): Promise<unknown>;
  psubscribe(...args: unknown[]): Promise<unknown>;
  punsubscribe(...args: unknown[]): Promise<unknown>;
  publish(channel: string, message: string | Buffer): Promise<number>;
  send_command?(command: string, args: unknown[], callback?: (err: Error | null, res?: unknown) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
};

export type AttachRealtimeOptions = {
  database?: PrismaClient;
  redisUrl?: string;
  enableRedisAdapter?: boolean;
  adapterKey?: string;
  outboxChannel?: string;
  revalidateIntervalMs?: number;
  metrics?: MetricsCollector;
  createRedisClient?: (url: string, options: RedisOptions, role: 'events_sub' | 'adapter_pub' | 'adapter_sub') => RealtimeRedisLike;
};

type RealtimeHealthProbe = () => boolean | Promise<boolean>;
type RealtimeEventPublisher = (event: OperationalEvent) => Promise<boolean>;

let realtimeHealthProbe: RealtimeHealthProbe | undefined;
let activeRealtimeEventPublisher: RealtimeEventPublisher | undefined;

/** Registers the readiness probe checked by GET /ready for the realtime Redis bridge. */
export function setRealtimeRedisHealthProbe(probe: RealtimeHealthProbe | undefined): void {
  realtimeHealthProbe = probe;
}

/** Reports whether the attached Socket.IO Redis adapter and event subscriber are ready. */
export async function realtimeRedisReady(): Promise<boolean> {
  if (!realtimeHealthProbe) return true;
  try {
    return Boolean(await realtimeHealthProbe());
  } catch {
    return false;
  }
}

/** Publishes a committed operational/revocation event via the active API Redis publisher on a best-effort basis. */
export async function publishRealtimeOperationalEvent(event: OperationalEvent): Promise<boolean> {
  if (!activeRealtimeEventPublisher) return false;
  try {
    return await activeRealtimeEventPublisher(event);
  } catch {
    return false;
  }
}

/** Creates a bounded FIFO deduplication cache keyed by eventId to suppress at-least-once duplicates cleanly. */
export function createEventDeduplicator(maxSize = MAX_SEEN_EVENT_IDS) {
  const seen = new Set<string>();
  return {
    has(eventId: string): boolean {
      return seen.has(eventId);
    },
    mark(eventId: string): void {
      if (seen.has(eventId) || maxSize <= 0) return;
      if (seen.size >= maxSize) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.add(eventId);
    },
    get size(): number {
      return seen.size;
    },
  };
}

/** Extracts and URI-decodes the named cookie value safely, returning undefined on malformed input. */
export function extractCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolveSocketTokenHash(socket: RealtimeSocketLike): string | undefined {
  const tokenHash = typeof socket.data.tokenHash === 'string' ? socket.data.tokenHash : undefined;
  if (tokenHash && SESSION_TOKEN_RE.test(tokenHash)) {
    return tokenHash.toLowerCase();
  }
  const legacyToken = typeof socket.data.token === 'string' ? socket.data.token : undefined;
  if (legacyToken && SESSION_TOKEN_RE.test(legacyToken)) {
    return digest(legacyToken);
  }
  return undefined;
}

function isAclDeniedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /NOPERM|no permissions/i.test(msg);
}

type BatchedAuthLookup = {
  validSessionByHash: Map<string, { userId: string; tenantId: string; storeId: string; role: string }>;
  deviceById: Map<string, { id: string; userId: string; stationId: string | null }>;
};

async function loadSocketAuthState(
  database: PrismaClient,
  sockets: readonly RealtimeSocketLike[],
  scopeFilter?: { tenantId: string; storeId: string },
): Promise<BatchedAuthLookup> {
  const tokenHashes = new Set<string>();
  const deviceIds = new Set<string>();

  for (const socket of sockets) {
    if (socket.data.customerTrackingHash) continue;
    const tokenHash = resolveSocketTokenHash(socket);
    if (tokenHash) {
      tokenHashes.add(tokenHash);
    }
    const deviceId = typeof socket.data.deviceId === 'string' ? socket.data.deviceId : undefined;
    if (deviceId && DEVICE_UUID_RE.test(deviceId)) {
      deviceIds.add(deviceId);
    }
  }

  const validSessionByHash = new Map<string, { userId: string; tenantId: string; storeId: string; role: string }>();
  const deviceById = new Map<string, { id: string; userId: string; stationId: string | null }>();

  if (tokenHashes.size === 0) {
    return { validSessionByHash, deviceById };
  }

  const sessions = await database.session.findMany({
    where: {
      tokenHash: { in: [...tokenHashes] },
      expiresAt: { gt: new Date() },
      ...(scopeFilter ? { tenantId: scopeFilter.tenantId, storeId: scopeFilter.storeId } : {}),
      user: { active: true },
    },
    select: { tokenHash: true, userId: true, tenantId: true, storeId: true },
  });

  if (sessions.length === 0) {
    return { validSessionByHash, deviceById };
  }

  const userIds = [...new Set(sessions.map(session => session.userId))];
  const storeIds = [...new Set(sessions.map(session => session.storeId))];
  const [memberships, devices] = await Promise.all([
    database.membership.findMany({
      where: {
        userId: { in: userIds },
        storeId: { in: storeIds },
        ...(scopeFilter ? { tenantId: scopeFilter.tenantId, storeId: scopeFilter.storeId } : {}),
      },
      select: { userId: true, tenantId: true, storeId: true, role: true },
    }),
    deviceIds.size > 0
      ? database.kitchenDevice.findMany({
          where: {
            id: { in: [...deviceIds] },
            ...(scopeFilter ? { tenantId: scopeFilter.tenantId, storeId: scopeFilter.storeId } : {}),
            revokedAt: null,
          },
          select: { id: true, tenantId: true, storeId: true, userId: true, stationId: true },
        })
      : Promise.resolve([]),
  ]);

  const membershipByKey = new Map(
    memberships.map(member => [`${member.userId}:${member.storeId}:${member.tenantId}`, member]),
  );

  for (const session of sessions) {
    const member = membershipByKey.get(`${session.userId}:${session.storeId}:${session.tenantId}`);
    if (!member) continue;
    validSessionByHash.set(session.tokenHash, {
      userId: session.userId,
      tenantId: session.tenantId,
      storeId: session.storeId,
      role: member.role,
    });
  }

  for (const device of devices) {
    deviceById.set(`${device.id}:${device.tenantId}:${device.storeId}`, {
      id: device.id,
      userId: device.userId,
      stationId: device.stationId,
    });
  }

  return { validSessionByHash, deviceById };
}

/**
 * Wraps the adapter publish client so fire-and-forget RedisAdapter publishes
 * never trigger UnhandledPromiseRejection when Redis is offline or ACL-restricted.
 */
function wrapAdapterPubClient(
  rawClient: RealtimeRedisLike,
  onPublishError: (err: unknown) => void,
): RealtimeRedisLike {
  return new Proxy(rawClient, {
    get(target, prop) {
      if (prop === 'publish') {
        return async (channel: string, message: string | Buffer): Promise<number> => {
          try {
            return await target.publish(channel, message);
          } catch (err) {
            onPublishError(err);
            return 0;
          }
        };
      }
      if (prop === 'off' && typeof target.off !== 'function' && typeof target.removeListener === 'function') {
        return target.removeListener.bind(target);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps the adapter subscribe client so initial constructor psubscribe/subscribe
 * and teardown unsubscribes track explicit ACL/connection readiness without unhandled rejections.
 */
function wrapAdapterSubClient(
  rawClient: RealtimeRedisLike,
  onSubState: (op: 'psubscribe' | 'subscribe', ok: boolean, err?: unknown, args?: unknown[]) => void,
): RealtimeRedisLike {
  return new Proxy(rawClient, {
    get(target, prop) {
      if (prop === 'psubscribe') {
        return (...args: unknown[]) => {
          onSubState('psubscribe', false, undefined, args);
          const p = target.psubscribe(...args);
          p.then(() => onSubState('psubscribe', true, undefined, args)).catch((err: unknown) =>
            onSubState('psubscribe', false, err, args),
          );
          return p.catch(() => undefined);
        };
      }
      if (prop === 'subscribe') {
        return (...args: unknown[]) => {
          onSubState('subscribe', false, undefined, args);
          const p = target.subscribe(...args);
          p.then(() => onSubState('subscribe', true, undefined, args)).catch((err: unknown) =>
            onSubState('subscribe', false, err, args),
          );
          return p.catch(() => undefined);
        };
      }
      if (prop === 'punsubscribe') {
        return (...args: unknown[]) => target.punsubscribe(...args).catch(() => undefined);
      }
      if (prop === 'unsubscribe') {
        return (...args: unknown[]) => target.unsubscribe(...args).catch(() => undefined);
      }
      if (prop === 'off' && typeof target.off !== 'function' && typeof target.removeListener === 'function') {
        return target.removeListener.bind(target);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Broadcasts one operational event locally on this replica to the authorized tenant/store room
 * using constant batched database queries, and disconnects revoked or drifted sockets immediately.
 */
export async function broadcastOperationalEvent(
  io: RealtimeServerLike,
  database: PrismaClient,
  event: OperationalEvent,
  metrics: MetricsCollector = apiMetrics,
): Promise<void> {
  const localIo = io.local ?? io;
  if (CUSTOMER_ORDER_EVENTS.has(event.type)) {
    localIo.to(`${event.tenantId}:${event.storeId}:order:${event.aggregateId}`).emit('customer.order.updated');
  }

  const room = `${event.tenantId}:${event.storeId}`;
  const sockets = await localIo.in(room).fetchSockets();
  if (sockets.length === 0) return;

  const { validSessionByHash, deviceById } = await loadSocketAuthState(database, sockets, {
    tenantId: event.tenantId,
    storeId: event.storeId,
  });

  const stationIds = new Set<string>();
  let revokedCount = 0;

  const resolved = sockets.map(socket => {
    if (socket.data.customerTrackingHash || socket.data.room !== room) {
      socket.disconnect(true);
      revokedCount++;
      return null;
    }
    const tokenHash = resolveSocketTokenHash(socket);
    if (!tokenHash) {
      socket.disconnect(true);
      revokedCount++;
      return null;
    }
    const session = validSessionByHash.get(tokenHash);
    if (!session || session.tenantId !== event.tenantId || session.storeId !== event.storeId) {
      socket.disconnect(true);
      revokedCount++;
      return null;
    }
    const deviceId = typeof socket.data.deviceId === 'string' ? socket.data.deviceId : undefined;
    if (session.role === 'KITCHEN' && !deviceId) {
      socket.disconnect(true);
      revokedCount++;
      return null;
    }
    if (!deviceId) {
      return { socket, stationId: null as string | null };
    }
    const device = deviceById.get(`${deviceId}:${session.tenantId}:${session.storeId}`);
    if (!device || device.userId !== session.userId || device.stationId !== (socket.data.stationId as string | null)) {
      socket.disconnect(true);
      revokedCount++;
      return null;
    }
    if (device.stationId && event.type !== 'kitchen.device.changed') {
      stationIds.add(device.stationId);
    }
    return { socket, stationId: device.stationId };
  });

  if (revokedCount > 0) {
    const revocationType = event.type === 'session.revoked'
      ? 'session_revoked'
      : event.type === 'kitchen.device.changed'
        ? 'kitchen_device_changed'
        : 'periodic_drift';
    metrics.recordRealtimeRevocation(revocationType, revokedCount);
    apiLogger.security('info', 'REALTIME_SOCKET_REVOKED', {
      component: 'realtime',
      reason: revocationType,
      count: revokedCount,
    });
  }

  // Never disclose user session revocation signals to other staff sockets in the store.
  if (REVOCATION_ONLY_EVENTS.has(event.type)) {
    return;
  }

  const matchingStations = stationIds.size > 0
    ? new Set(
        (await database.kitchenTicket.findMany({
          where: {
            tenantId: event.tenantId,
            storeId: event.storeId,
            orderId: event.aggregateId,
            stationId: { in: [...stationIds] },
          },
          select: { stationId: true },
        })).map(ticket => ticket.stationId),
      )
    : new Set<string>();

  for (const entry of resolved) {
    if (!entry) continue;
    if (entry.stationId && !matchingStations.has(entry.stationId)) continue;
    entry.socket.emit('operational.event', event);
  }
}

/**
 * Periodically revalidates all connected employee, kitchen-device, and tracking sockets
 * in batched queries and disconnects sockets whose session, membership, device, or room drifted.
 */
export async function revalidateRealtimeSockets(
  socketsIterable: Iterable<RealtimeSocketLike>,
  database: PrismaClient,
  metrics: MetricsCollector = apiMetrics,
): Promise<void> {
  const sockets = [...socketsIterable];
  if (sockets.length === 0) return;

  const trackingHashes = [...new Set(
    sockets
      .map(socket => (typeof socket.data.customerTrackingHash === 'string' ? socket.data.customerTrackingHash : undefined))
      .filter((hash): hash is string => Boolean(hash)),
  )];

  const [validOrders, authState] = await Promise.all([
    trackingHashes.length > 0
      ? database.order.findMany({
          where: { trackingTokenHash: { in: trackingHashes } },
          select: { trackingTokenHash: true },
        })
      : Promise.resolve([]),
    loadSocketAuthState(database, sockets),
  ]);

  const activeTrackingHashes = new Set(
    validOrders.map(order => order.trackingTokenHash).filter((hash): hash is string => Boolean(hash)),
  );

  let driftedCount = 0;
  for (const socket of sockets) {
    if (typeof socket.data.customerTrackingHash === 'string') {
      if (!activeTrackingHashes.has(socket.data.customerTrackingHash)) {
        socket.disconnect(true);
        driftedCount++;
      }
      continue;
    }

    const tokenHash = resolveSocketTokenHash(socket);
    if (!tokenHash) {
      socket.disconnect(true);
      driftedCount++;
      continue;
    }
    const session = authState.validSessionByHash.get(tokenHash);
    if (!session || socket.data.room !== `${session.tenantId}:${session.storeId}`) {
      socket.disconnect(true);
      driftedCount++;
      continue;
    }
    const deviceId = typeof socket.data.deviceId === 'string' ? socket.data.deviceId : undefined;
    if (session.role === 'KITCHEN' && !deviceId) {
      socket.disconnect(true);
      driftedCount++;
      continue;
    }
    if (deviceId) {
      const device = authState.deviceById.get(`${deviceId}:${session.tenantId}:${session.storeId}`);
      if (!device || device.userId !== session.userId || device.stationId !== (socket.data.stationId as string | null)) {
        socket.disconnect(true);
        driftedCount++;
      }
    }
  }

  if (driftedCount > 0) {
    metrics.recordRealtimeRevocation('periodic_drift', driftedCount);
    apiLogger.security('info', 'REALTIME_SOCKET_REVOKED', {
      component: 'realtime',
      reason: 'periodic_drift',
      count: driftedCount,
    });
  }
}

/** Attaches origin-enforced Socket.IO gateway, Redis Adapter, and resilient Outbox subscriber to HTTP server. */
export function attachRealtime(server: HttpServer, origin: string, options: AttachRealtimeOptions = {}) {
  const database = options.database ?? db;
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const enableRedisAdapter = options.enableRedisAdapter ?? true;
  const adapterKey = options.adapterKey ?? DEFAULT_REALTIME_ADAPTER_KEY;
  const outboxChannel = options.outboxChannel ?? DEFAULT_OUTBOX_CHANNEL;
  const revalidateIntervalMs = options.revalidateIntervalMs ?? 30_000;
  const metrics = options.metrics ?? apiMetrics;
  const deduper = createEventDeduplicator(MAX_SEEN_EVENT_IDS);

  let activeSockets = 0;
  metrics.setRealtimeConnectedSockets(0);
  metrics.setRealtimeAdapterReady(false);

  const defaultFactory = (url: string, clientOpts: RedisOptions): RealtimeRedisLike =>
    new Redis(url, clientOpts) as unknown as RealtimeRedisLike;
  const makeRedis = options.createRedisClient ?? ((url, clientOpts) => defaultFactory(url, clientOpts));

  const subscriber = makeRedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false }, 'events_sub');
  const adapterPubClient = enableRedisAdapter
    ? makeRedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false }, 'adapter_pub')
    : undefined;
  const adapterSubClient = enableRedisAdapter
    ? makeRedis(redisUrl, { maxRetriesPerRequest: 1, autoResubscribe: true }, 'adapter_sub')
    : undefined;

  let closing = false;
  let eventsSubConnected = false;
  let eventsSubFailed = false;
  let eventsSubSubscribed = false;

  let adapterPubConnected = !enableRedisAdapter;
  let adapterPubFailed = false;
  let adapterPubAclDenied = false;
  let adapterSubTcpConnected = !enableRedisAdapter;
  let adapterSubFailed = false;
  let adapterSubAclDenied = false;
  let adapterPsubConfirmed = !enableRedisAdapter;
  let adapterSubConfirmed = !enableRedisAdapter;
  let eventsSubAclDenied = false;

  const isAdapterAndEventsReady = () =>
    !closing &&
    eventsSubConnected &&
    eventsSubSubscribed &&
    !eventsSubAclDenied &&
    adapterPubConnected &&
    !adapterPubAclDenied &&
    adapterSubTcpConnected &&
    adapterPsubConfirmed &&
    adapterSubConfirmed &&
    !adapterSubAclDenied;

  let lastOverallReady = false;
  const syncReadiness = () => {
    const readyNow = isAdapterAndEventsReady();
    metrics.setRealtimeAdapterReady(readyNow);
    if (readyNow && !lastOverallReady) {
      apiLogger.ops('info', 'REALTIME_ADAPTER_READY', { component: 'realtime' });
    }
    lastOverallReady = readyNow;
  };

  const io = new Server(server, {
    cors: { origin, credentials: true },
    allowRequest: (req, done) => {
      const allowedOrigin = req.headers.origin === origin;
      if (!allowedOrigin) metrics.recordRealtimeConnection(false);
      done(null, allowedOrigin);
    },
  });

  if (adapterPubClient && adapterSubClient) {
    // Attach listeners before passing clients to createAdapter so friendlyErrorHandler never warns.
    adapterPubClient.on('error', error => {
      const acl = isAclDeniedError(error);
      if (acl) adapterPubAclDenied = true;
      adapterPubConnected = false;
      if (!adapterPubFailed || acl) {
        metrics.recordRealtimeAdapterError(acl ? 'acl' : 'adapter_pub');
        apiLogger.ops('warn', 'REALTIME_REDIS_UNAVAILABLE', {
          component: 'realtime',
          role: 'adapter_pub',
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      adapterPubFailed = true;
      syncReadiness();
    });
    adapterPubClient.on('ready', () => {
      if (!adapterPubConnected) {
        apiLogger.ops('info', 'REALTIME_REDIS_READY', { component: 'realtime', role: 'adapter_pub' });
      }
      adapterPubConnected = true;
      adapterPubFailed = false;
      adapterPubAclDenied = false;
      syncReadiness();
    });
    adapterPubClient.on('close', () => {
      adapterPubConnected = false;
      syncReadiness();
    });
    adapterPubClient.on('end', () => {
      adapterPubConnected = false;
      syncReadiness();
    });

    adapterSubClient.on('error', error => {
      const acl = isAclDeniedError(error);
      if (acl) adapterSubAclDenied = true;
      adapterSubTcpConnected = false;
      if (!adapterSubFailed || acl) {
        metrics.recordRealtimeAdapterError(acl ? 'acl' : 'adapter_sub');
        apiLogger.ops(acl ? 'error' : 'warn', acl ? 'REALTIME_ADAPTER_SUBSCRIPTION_FAILED' : 'REALTIME_REDIS_UNAVAILABLE', {
          component: 'realtime',
          role: 'adapter_sub',
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
      adapterSubFailed = true;
      syncReadiness();
    });
    let lastPsubArgs: unknown[] | undefined;
    let lastSubArgs: unknown[] | undefined;

    const subProxy = wrapAdapterSubClient(adapterSubClient, (op, ok, err, args) => {
      if (op === 'psubscribe') {
        if (args) lastPsubArgs = args;
        adapterPsubConfirmed = ok;
      }
      if (op === 'subscribe') {
        if (args) lastSubArgs = args;
        adapterSubConfirmed = ok;
      }
      if (!ok && err && !closing) {
        const acl = isAclDeniedError(err);
        if (acl) adapterSubAclDenied = true;
        metrics.recordRealtimeAdapterError(acl ? 'acl' : 'adapter_sub');
        apiLogger.ops('error', 'REALTIME_ADAPTER_SUBSCRIPTION_FAILED', {
          component: 'realtime',
          role: 'adapter_sub',
          operation: op,
          errorType: err instanceof Error ? err.name : typeof err,
        });
      }
      syncReadiness();
    });

    adapterSubClient.on('ready', () => {
      if (!adapterSubTcpConnected) {
        apiLogger.ops('info', 'REALTIME_REDIS_READY', { component: 'realtime', role: 'adapter_sub' });
      }
      adapterSubTcpConnected = true;
      adapterSubFailed = false;
      adapterSubAclDenied = false;
      // Re-verify adapter subscriptions on recovery when initial or prior auto-resubscribe dropped.
      if (!adapterPsubConfirmed && lastPsubArgs) {
        void subProxy.psubscribe(...lastPsubArgs);
      }
      if (!adapterSubConfirmed && lastSubArgs) {
        void subProxy.subscribe(...lastSubArgs);
      }
      syncReadiness();
    });
    adapterSubClient.on('close', () => {
      adapterSubTcpConnected = false;
      adapterPsubConfirmed = false;
      adapterSubConfirmed = false;
      syncReadiness();
    });
    adapterSubClient.on('end', () => {
      adapterSubTcpConnected = false;
      adapterPsubConfirmed = false;
      adapterSubConfirmed = false;
      syncReadiness();
    });

    const pubProxy = wrapAdapterPubClient(adapterPubClient, err => {
      if (closing) return;
      const acl = isAclDeniedError(err);
      if (acl) adapterPubAclDenied = true;
      metrics.recordRealtimeAdapterError(acl ? 'acl' : 'adapter_pub');
      apiLogger.ops('warn', 'REALTIME_ADAPTER_PUBLISH_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
      syncReadiness();
    });

    io.adapter(createAdapter(pubProxy, subProxy, { key: adapterKey }));
  }

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as Record<string, unknown> | undefined;
      if (auth && 'trackingToken' in auth && auth.trackingToken !== undefined) {
        const trackingToken = typeof auth.trackingToken === 'string' ? auth.trackingToken : '';
        if (!TRACKING_TOKEN_RE.test(trackingToken)) throw new Error('TRACKING_NOT_FOUND');
        const trackingHash = digest(trackingToken);
        const order = await database.order.findFirst({
          where: { trackingTokenHash: trackingHash },
          select: { tenantId: true, storeId: true, id: true },
        });
        if (!order) throw new Error('TRACKING_NOT_FOUND');
        socket.data.customerTrackingHash = trackingHash;
        socket.data.customerRoom = `${order.tenantId}:${order.storeId}:order:${order.id}`;
        next();
        return;
      }

      const token = extractCookieValue(socket.request.headers.cookie, 'session');
      const c = await authenticate(database, token);
      const deviceId = typeof auth?.deviceId === 'string' ? auth.deviceId : undefined;
      if (c.role === 'KITCHEN' || deviceId !== undefined) {
        if (!deviceId || !DEVICE_UUID_RE.test(deviceId)) throw new Error('KITCHEN_DEVICE_REQUIRED');
        const device = await database.kitchenDevice.findFirst({
          where: { id: deviceId, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null },
          select: { id: true, stationId: true },
        });
        if (!device) throw new Error('KITCHEN_DEVICE_NOT_AUTHORIZED');
        socket.data.deviceId = device.id;
        socket.data.stationId = device.stationId;
      }
      // Store only the SHA-256 token digest so raw session cookies never reside in socket.data.
      socket.data.tokenHash = c.tokenHash;
      socket.data.userId = c.userId;
      socket.data.room = `${c.tenantId}:${c.storeId}`;
      next();
    } catch (err) {
      metrics.recordRealtimeConnection(false);
      apiLogger.security('warn', 'REALTIME_HANDSHAKE_REJECTED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', socket => {
    socket.on('error', () => {
      socket.disconnect(true);
    });
    const assignedRoom = typeof socket.data.customerRoom === 'string'
      ? socket.data.customerRoom
      : typeof socket.data.room === 'string'
        ? socket.data.room
        : undefined;
    if (!assignedRoom) {
      metrics.recordRealtimeConnection(false);
      socket.disconnect(true);
      return;
    }
    activeSockets++;
    metrics.setRealtimeConnectedSockets(activeSockets);
    metrics.recordRealtimeConnection(true);
    let disconnected = false;
    socket.once('disconnect', reason => {
      if (disconnected) return;
      disconnected = true;
      activeSockets = Math.max(0, activeSockets - 1);
      metrics.setRealtimeConnectedSockets(activeSockets);
      metrics.recordRealtimeDisconnect(reason);
    });
    void socket.join(assignedRoom);
  });

  subscriber.on('error', error => {
    const acl = isAclDeniedError(error);
    if (acl) eventsSubAclDenied = true;
    eventsSubConnected = false;
    eventsSubSubscribed = false;
    if (!eventsSubFailed || acl) {
      metrics.recordRealtimeAdapterError(acl ? 'acl' : 'events_sub');
      apiLogger.ops('warn', 'REALTIME_REDIS_UNAVAILABLE', {
        component: 'realtime',
        role: 'events_sub',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
    eventsSubFailed = true;
    syncReadiness();
  });
  subscriber.on('close', () => {
    eventsSubConnected = false;
    eventsSubSubscribed = false;
    eventsSubFailed = true;
    syncReadiness();
  });
  subscriber.on('end', () => {
    eventsSubConnected = false;
    eventsSubSubscribed = false;
    eventsSubFailed = true;
    syncReadiness();
  });
  // Initial subscribe can exhaust retries while Redis is down; re-register and catch up on recovery.
  subscriber.on('ready', () => {
    const recovering = eventsSubFailed;
    if (!eventsSubConnected) {
      apiLogger.ops('info', 'REALTIME_REDIS_READY', { component: 'realtime', role: 'events_sub' });
    }
    eventsSubConnected = true;
    eventsSubSubscribed = false;
    eventsSubAclDenied = false;
    syncReadiness();

    void subscriber.subscribe(outboxChannel)
      .then(() => {
        if (closing) return;
        eventsSubSubscribed = true;
        eventsSubFailed = false;
        syncReadiness();
        if (recovering) {
          void revalidateRealtimeSockets(io.sockets.sockets.values(), database, metrics).catch((err: unknown) => {
            metrics.recordRealtimeAdapterError('revalidate');
            apiLogger.ops('warn', 'REALTIME_REVALIDATE_FAILED', {
              component: 'realtime',
              errorType: err instanceof Error ? err.name : typeof err,
            });
          });
        }
      })
      .catch((err: unknown) => {
        eventsSubSubscribed = false;
        eventsSubFailed = true;
        const acl = isAclDeniedError(err);
        if (acl) eventsSubAclDenied = true;
        metrics.recordRealtimeAdapterError(acl ? 'acl' : 'events_sub');
        apiLogger.ops('error', 'REALTIME_SUBSCRIBE_FAILED', {
          component: 'realtime',
          role: 'events_sub',
          errorType: err instanceof Error ? err.name : typeof err,
        });
        syncReadiness();
      });
  });

  const inFlightEvents = new Map<string, Promise<void>>();

  subscriber.on('message', async (_channel, message) => {
    try {
      const parsed = eventSchema.safeParse(JSON.parse(String(message)));
      if (!parsed.success) {
        metrics.recordRealtimeBroadcast('invalid_payload');
        apiLogger.ops('warn', 'REALTIME_EVENT_INVALID', { component: 'realtime' });
        return;
      }
      const { eventId } = parsed.data;
      const pending = inFlightEvents.get(eventId);
      if (pending) {
        await pending.catch(() => undefined);
      }
      if (deduper.has(eventId)) {
        metrics.recordRealtimeBroadcast('deduplicated');
        return;
      }
      const work = (async () => {
        await broadcastOperationalEvent(io as unknown as RealtimeServerLike, database, parsed.data, metrics);
        deduper.mark(eventId);
        metrics.recordRealtimeBroadcast('broadcast');
      })();
      inFlightEvents.set(eventId, work);
      try {
        await work;
      } finally {
        if (inFlightEvents.get(eventId) === work) {
          inFlightEvents.delete(eventId);
        }
      }
    } catch (err) {
      /* malformed or transiently failed broker payload never reaches clients */
      metrics.recordRealtimeBroadcast('error');
      apiLogger.ops('error', 'REALTIME_BROADCAST_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
  });

  setRealtimeRedisHealthProbe(isAdapterAndEventsReady);
  activeRealtimeEventPublisher = async (event: OperationalEvent): Promise<boolean> => {
    if (!adapterPubClient || !adapterPubConnected || closing) return false;
    try {
      await adapterPubClient.publish(outboxChannel, JSON.stringify(event));
      return true;
    } catch (err) {
      metrics.recordRealtimeAdapterError(isAclDeniedError(err) ? 'acl' : 'adapter_pub');
      apiLogger.ops('warn', 'REALTIME_ADAPTER_PUBLISH_FAILED', {
        component: 'realtime',
        channel: outboxChannel,
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return false;
    }
  };

  const timer = setInterval(() => {
    void revalidateRealtimeSockets(io.sockets.sockets.values(), database, metrics).catch((err: unknown) => {
      metrics.recordRealtimeAdapterError('revalidate');
      apiLogger.ops('warn', 'REALTIME_REVALIDATE_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
    });
  }, revalidateIntervalMs);
  timer.unref?.();

  return async () => {
    closing = true;
    clearInterval(timer);
    setRealtimeRedisHealthProbe(undefined);
    activeRealtimeEventPublisher = undefined;
    metrics.setRealtimeAdapterReady(false);

    await io.close().catch(() => undefined);
    activeSockets = 0;
    metrics.setRealtimeConnectedSockets(0);

    const clients = [subscriber, adapterSubClient, adapterPubClient].filter(
      (client): client is RealtimeRedisLike => Boolean(client),
    );
    await Promise.all(
      clients.map(client =>
        client.status === 'ready'
          ? Promise.race([
              client.quit().catch(() => undefined),
              new Promise<void>(resolve => setTimeout(resolve, 500)),
            ])
          : Promise.resolve(),
      ),
    );
    for (const client of clients) {
      try {
        client.disconnect();
      } catch {
        // Ignore teardown errors on already-closed Redis sockets.
      }
    }
  };
}
