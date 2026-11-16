import { Server } from 'socket.io';
import Redis from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { eventSchema, type OperationalEvent } from '@omnihub/contracts';
import { digest } from './domain';
import { authenticate } from './auth';
import { db } from './database';
import { apiLogger } from './observability/logger';
import { apiMetrics } from './observability/metrics';

const TRACKING_TOKEN_RE = /^[a-f0-9]{64}$/i;
const SESSION_TOKEN_RE = /^[a-f0-9]{64}$/i;
const DEVICE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUSTOMER_ORDER_EVENTS = new Set([
  'order.accepted',
  'order.cancelled',
  'order.item.cancelled',
  'kitchen.item.started',
  'kitchen.item.ready',
  'kitchen.item.handed_off',
]);

export type RealtimeSocketLike = {
  id?: string;
  data: Record<string, unknown>;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(close?: boolean): unknown;
};

export type RealtimeServerLike = {
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
  in(room: string): { fetchSockets(): Promise<RealtimeSocketLike[]> };
  sockets?: { sockets: { values(): IterableIterator<RealtimeSocketLike> } };
};

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
    const token = typeof socket.data.token === 'string' ? socket.data.token : undefined;
    if (token && SESSION_TOKEN_RE.test(token)) {
      tokenHashes.add(digest(token));
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
 * Broadcasts one operational event to the authorized tenant/store room using constant
 * batched database queries instead of per-socket lookups, disconnecting revoked/mismatched sockets.
 */
export async function broadcastOperationalEvent(
  io: RealtimeServerLike,
  database: PrismaClient,
  event: OperationalEvent,
): Promise<void> {
  if (CUSTOMER_ORDER_EVENTS.has(event.type)) {
    io.to(`${event.tenantId}:${event.storeId}:order:${event.aggregateId}`).emit('customer.order.updated');
  }

  const room = `${event.tenantId}:${event.storeId}`;
  const sockets = await io.in(room).fetchSockets();
  if (sockets.length === 0) return;

  const { validSessionByHash, deviceById } = await loadSocketAuthState(database, sockets, {
    tenantId: event.tenantId,
    storeId: event.storeId,
  });

  const stationIds = new Set<string>();
  const resolved = sockets.map(socket => {
    if (socket.data.customerTrackingHash || socket.data.room !== room) {
      socket.disconnect();
      return null;
    }
    const token = typeof socket.data.token === 'string' ? socket.data.token : undefined;
    if (!token || !SESSION_TOKEN_RE.test(token)) {
      socket.disconnect();
      return null;
    }
    const session = validSessionByHash.get(digest(token));
    if (!session || session.tenantId !== event.tenantId || session.storeId !== event.storeId) {
      socket.disconnect();
      return null;
    }
    const deviceId = typeof socket.data.deviceId === 'string' ? socket.data.deviceId : undefined;
    if (session.role === 'KITCHEN' && !deviceId) {
      socket.disconnect();
      return null;
    }
    if (!deviceId) {
      return { socket, stationId: null as string | null };
    }
    const device = deviceById.get(`${deviceId}:${session.tenantId}:${session.storeId}`);
    if (!device || device.userId !== session.userId || device.stationId !== (socket.data.stationId as string | null)) {
      socket.disconnect();
      return null;
    }
    if (device.stationId) stationIds.add(device.stationId);
    return { socket, stationId: device.stationId };
  });

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

  for (const socket of sockets) {
    if (typeof socket.data.customerTrackingHash === 'string') {
      if (!activeTrackingHashes.has(socket.data.customerTrackingHash)) {
        socket.disconnect();
      }
      continue;
    }

    const token = typeof socket.data.token === 'string' ? socket.data.token : undefined;
    if (!token || !SESSION_TOKEN_RE.test(token)) {
      socket.disconnect();
      continue;
    }
    const session = authState.validSessionByHash.get(digest(token));
    if (!session || socket.data.room !== `${session.tenantId}:${session.storeId}`) {
      socket.disconnect();
      continue;
    }
    const deviceId = typeof socket.data.deviceId === 'string' ? socket.data.deviceId : undefined;
    if (session.role === 'KITCHEN' && !deviceId) {
      socket.disconnect();
      continue;
    }
    if (deviceId) {
      const device = authState.deviceById.get(`${deviceId}:${session.tenantId}:${session.storeId}`);
      if (!device || device.userId !== session.userId || device.stationId !== (socket.data.stationId as string | null)) {
        socket.disconnect();
      }
    }
  }
}

/** Attaches origin-enforced Socket.IO gateway and Redis Pub/Sub invalidation bridge to HTTP server. */
export function attachRealtime(server: HttpServer, origin: string) {
  let activeSockets = 0;
  apiMetrics.setRealtimeConnectedSockets(0);

  const io = new Server(server, {
    cors: { origin, credentials: true },
    allowRequest: (req, done) => {
      const allowedOrigin = req.headers.origin === origin;
      if (!allowedOrigin) apiMetrics.recordRealtimeConnection(false);
      done(null, allowedOrigin);
    },
  });

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as Record<string, unknown> | undefined;
      if (auth && 'trackingToken' in auth && auth.trackingToken !== undefined) {
        const trackingToken = typeof auth.trackingToken === 'string' ? auth.trackingToken : '';
        if (!TRACKING_TOKEN_RE.test(trackingToken)) throw new Error('TRACKING_NOT_FOUND');
        const trackingHash = digest(trackingToken);
        const order = await db.order.findFirst({
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
      const c = await authenticate(db, token);
      const deviceId = typeof auth?.deviceId === 'string' ? auth.deviceId : undefined;
      if (c.role === 'KITCHEN' || deviceId !== undefined) {
        if (!deviceId || !DEVICE_UUID_RE.test(deviceId)) throw new Error('KITCHEN_DEVICE_REQUIRED');
        const device = await db.kitchenDevice.findFirst({
          where: { id: deviceId, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null },
          select: { id: true, stationId: true },
        });
        if (!device) throw new Error('KITCHEN_DEVICE_NOT_AUTHORIZED');
        socket.data.deviceId = device.id;
        socket.data.stationId = device.stationId;
      }
      socket.data.token = token;
      socket.data.room = `${c.tenantId}:${c.storeId}`;
      next();
    } catch (err) {
      apiMetrics.recordRealtimeConnection(false);
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
      apiMetrics.recordRealtimeConnection(false);
      socket.disconnect(true);
      return;
    }
    activeSockets++;
    apiMetrics.setRealtimeConnectedSockets(activeSockets);
    apiMetrics.recordRealtimeConnection(true);
    let disconnected = false;
    socket.once('disconnect', reason => {
      if (disconnected) return;
      disconnected = true;
      activeSockets = Math.max(0, activeSockets - 1);
      apiMetrics.setRealtimeConnectedSockets(activeSockets);
      apiMetrics.recordRealtimeDisconnect(reason);
    });
    void socket.join(assignedRoom);
  });

  const subscriber = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  let realtimeRedisConnected = false;
  let realtimeRedisFailed = false;
  subscriber.on('error', error => {
    /* The Redis health probe keeps readiness fail-closed during an outage. */
    if (realtimeRedisConnected || !realtimeRedisFailed) {
      apiLogger.ops('warn', 'REALTIME_REDIS_UNAVAILABLE', { component: 'realtime', errorType: error.name });
    }
    realtimeRedisConnected = false;
    realtimeRedisFailed = true;
  });
  // Initial subscribe can exhaust retries while Redis is down; re-register on recovery.
  subscriber.on('ready', () => {
    if (!realtimeRedisConnected) apiLogger.ops('info', 'REALTIME_REDIS_READY', { component: 'realtime' });
    realtimeRedisConnected = true;
    void subscriber.subscribe('omnihub.events').catch((err: unknown) => {
      apiLogger.ops('error', 'REALTIME_SUBSCRIBE_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
    });
  });
  subscriber.on('message', async (_channel, message) => {
    try {
      const parsed = eventSchema.safeParse(JSON.parse(message));
      if (!parsed.success) {
        apiMetrics.recordRealtimeBroadcast('invalid_payload');
        apiLogger.ops('warn', 'REALTIME_EVENT_INVALID', { component: 'realtime' });
        return;
      }
      await broadcastOperationalEvent(io, db, parsed.data);
      apiMetrics.recordRealtimeBroadcast('broadcast');
    } catch (err) {
      /* malformed broker payload never reaches clients */
      apiMetrics.recordRealtimeBroadcast('error');
      apiLogger.ops('error', 'REALTIME_BROADCAST_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
  });

  const timer = setInterval(() => {
    void revalidateRealtimeSockets(io.sockets.sockets.values(), db).catch((err: unknown) => {
      apiLogger.ops('warn', 'REALTIME_REVALIDATE_FAILED', {
        component: 'realtime',
        errorType: err instanceof Error ? err.name : typeof err,
      });
    });
  }, 30_000);
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    await io.close();
    activeSockets = 0;
    apiMetrics.setRealtimeConnectedSockets(0);
    await Promise.race([
      subscriber.quit().catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 500)),
    ]);
    subscriber.disconnect();
  };
}
