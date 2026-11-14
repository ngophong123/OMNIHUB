import { Server } from 'socket.io';
import Redis from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import { eventSchema } from '@omnihub/contracts';
import { digest } from './domain';
import { authenticate } from './auth';
import { db } from './database';

export function attachRealtime(server: HttpServer, origin: string) {
  const io = new Server(server, { cors: { origin, credentials: true }, allowRequest: (req, done) => done(null, req.headers.origin === origin) });
  io.use(async (socket, next) => {
    try {
      const trackingToken = typeof socket.handshake.auth?.trackingToken === 'string' ? socket.handshake.auth.trackingToken : undefined;
      if (trackingToken && /^[a-f0-9]{64}$/i.test(trackingToken)) {
        const order = await db.order.findFirst({ where: { trackingTokenHash: digest(trackingToken) }, select: { tenantId: true, storeId: true, id: true } });
        if (!order) throw new Error('TRACKING_NOT_FOUND');
        socket.data.customerTrackingHash = digest(trackingToken);
        socket.data.customerRoom = `${order.tenantId}:${order.storeId}:order:${order.id}`;
        next(); return;
      }
      const token = socket.request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
      const c = await authenticate(db, token);
      const deviceId = typeof socket.handshake.auth?.deviceId === 'string' ? socket.handshake.auth.deviceId : undefined;
      if (c.role === 'KITCHEN' || deviceId) {
        if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) throw new Error('KITCHEN_DEVICE_REQUIRED');
        const device = await db.kitchenDevice.findFirst({ where: { id: deviceId, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null }, select: { id: true, stationId: true } });
        if (!device) throw new Error('KITCHEN_DEVICE_NOT_AUTHORIZED');
        socket.data.deviceId = device.id;
        socket.data.stationId = device.stationId;
      }
      socket.data.token = token;
      socket.data.room = `${c.tenantId}:${c.storeId}`;
      next();
    } catch { next(new Error('UNAUTHORIZED')); }
  });
  io.on('connection', socket => { void socket.join((socket.data.customerRoom ?? socket.data.room) as string); });
  const subscriber = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  subscriber.on('error', () => { /* The Redis health probe keeps readiness fail-closed during an outage. */ });
  // Initial subscribe can exhaust retries while Redis is down; re-register on recovery.
  subscriber.on('ready', () => { void subscriber.subscribe('omnihub.events').catch(() => undefined); });
  subscriber.on('message', async (_channel, message) => {
    try {
      const parsed = eventSchema.safeParse(JSON.parse(message));
      if (!parsed.success) return;
      const event = parsed.data;
      if (['order.accepted','order.cancelled','order.item.cancelled','kitchen.item.started','kitchen.item.ready','kitchen.item.handed_off'].includes(event.type)) {
        io.to(`${event.tenantId}:${event.storeId}:order:${event.aggregateId}`).emit('customer.order.updated');
      }
      const sockets = await io.in(`${event.tenantId}:${event.storeId}`).fetchSockets();
      for (const socket of sockets) {
        try {
          if (socket.data.customerTrackingHash) {
            const exists = await db.order.count({ where: { trackingTokenHash: socket.data.customerTrackingHash as string } });
            if (!exists) { socket.disconnect(); continue; }
            continue;
          }
          const c = await authenticate(db, socket.data.token as string);
          if (c.tenantId !== event.tenantId || c.storeId !== event.storeId) { socket.disconnect(); continue; }
          if (socket.data.deviceId) {
            const device = await db.kitchenDevice.findFirst({ where: { id: socket.data.deviceId as string, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null }, select: { stationId: true } });
            if (!device || device.stationId !== (socket.data.stationId as string | null)) { socket.disconnect(); continue; }
            if (device.stationId && !await db.kitchenTicket.findFirst({ where: { tenantId: c.tenantId, storeId: c.storeId, orderId: event.aggregateId, stationId: device.stationId }, select: { id: true } })) continue;
          }
          socket.emit('operational.event', event);
        } catch { socket.disconnect(); }
      }
    } catch { /* malformed broker payload never reaches clients */ }
  });
  const timer = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.customerTrackingHash) void db.order.count({ where: { trackingTokenHash: socket.data.customerTrackingHash as string } }).then(count => { if (!count) socket.disconnect(); }).catch(() => socket.disconnect());
      else void (async () => {
        const c = await authenticate(db, socket.data.token as string);
        if (socket.data.deviceId) {
          const device = await db.kitchenDevice.findFirst({ where: { id: socket.data.deviceId as string, tenantId: c.tenantId, storeId: c.storeId, userId: c.userId, revokedAt: null }, select: { stationId: true } });
          if (!device || device.stationId !== (socket.data.stationId as string | null)) socket.disconnect();
        }
      })().catch(() => socket.disconnect());
    }
  }, 30_000);
  return async () => { clearInterval(timer); await io.close(); subscriber.disconnect(); };
}
