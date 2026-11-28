'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { enqueueKitchenCommand, getKitchenDeviceId, pruneKitchenCommands, readKitchenCommands, readKitchenSnapshot, recoverKitchenCommands, reviewKitchenCommand, saveKitchenSnapshot, updateKitchenCommand, type KitchenOrderSnapshot, type KitchenScope, type OfflineAction, type OfflineKitchenCommand } from './kitchen-offline';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Identity = { userId: string; tenantId: string; storeId: string; role: string };
class KitchenError extends Error { constructor(public status: number, public code: string) { super(code); } }
async function request<T>(path: string, body?: unknown, deviceId?: string): Promise<T> {
  const headers: Record<string, string> = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (deviceId) headers['X-Kitchen-Device'] = deviceId;
  const response = await fetch(`${API}${path}`, { credentials: 'include', cache: 'no-store', ...(Object.keys(headers).length ? { headers } : {}), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new KitchenError(response.status, payload.code ?? 'SERVICE_UNAVAILABLE');
  return payload as T;
}
const copy = {
  vi: { online: 'Bếp trực tuyến', offline: 'Ngoại tuyến', offlineHint: 'Đang hiển thị phiếu bếp đã lưu. Không thể nhận đơn mới khi ngoại tuyến.', syncing: 'Đang đồng bộ', synced: 'Đã đồng bộ', pending: 'Chờ đồng bộ', retry: 'Đồng bộ lại', lastSync: 'Đồng bộ thành công gần nhất', start: 'Bắt đầu làm', ready: 'Đã xong', empty: 'Chưa có món cần chế biến', conflict: 'Cần xem lại thao tác ngoại tuyến', expected: 'Thao tác không khớp trạng thái hiện tại trên máy chủ.', review: 'Đã xem, giữ trong lịch sử', session: 'Phiên đăng nhập hết hạn. Đăng nhập lại để đồng bộ.', storage: 'Không thể lưu thao tác ngoại tuyến trên thiết bị này.', confirmed: 'Đã xác nhận', blocked: 'Tạm dừng do thao tác trước bị xung đột', rejected: 'Máy chủ từ chối thao tác', preparing: 'Đang chế biến', queued: 'Đã lưu trên thiết bị, chờ đồng bộ' },
  en: { online: 'Kitchen online', offline: 'Offline', offlineHint: 'Showing saved kitchen tickets. New orders cannot be received while offline.', syncing: 'Synchronizing', synced: 'Synchronized', pending: 'Pending sync', retry: 'Sync now', lastSync: 'Last successful sync', start: 'Start preparing', ready: 'Mark ready', empty: 'No items to prepare', conflict: 'Review offline action', expected: 'The action conflicts with the current server state.', review: 'Reviewed; retained in history', session: 'Session expired. Sign in again to synchronize.', storage: 'This device could not persist the offline action.', confirmed: 'Confirmed', blocked: 'Paused because an earlier action conflicted', rejected: 'Action rejected by server', queued: 'Saved on this device, waiting to sync' },
};
const itemLabel = (status: string, vi: boolean) => ({ PENDING: vi ? 'Mới' : 'New', PREPARING: vi ? 'Đang chế biến' : 'Preparing', READY: vi ? 'Đã xong' : 'Ready', HANDED_OFF: vi ? 'Đã giao' : 'Served', CANCELLED: vi ? 'Đã hủy' : 'Cancelled' }[status] ?? status);
function kitchenOnly(order: { id: string; status: string; version: number; createdAt: string; items: { id: string; name: string; status: string; ticketId: string; preparationNote?: string }[]; tickets: { id: string; station: { name: string } }[] }): KitchenOrderSnapshot {
  return { id: order.id, status: order.status, version: order.version, createdAt: order.createdAt, items: order.items.map(item => ({ id: item.id, name: item.name, status: item.status, ticketId: item.ticketId, preparationNote: item.preparationNote })), tickets: order.tickets.map(ticket => ({ id: ticket.id, station: { name: ticket.station.name } })) };
}
function predict(orders: KitchenOrderSnapshot[], commands: OfflineKitchenCommand[]): KitchenOrderSnapshot[] {
  const copy = structuredClone(orders);
  for (const command of commands) {
    if (!['PENDING', 'SENDING'].includes(command.status)) continue;
    const order = copy.find(row => row.id === command.orderId); const item = order?.items.find(row => row.id === command.itemId);
    if (!order || !item || order.version !== command.expectedVersion) continue;
    item.status = command.action === 'START' ? 'PREPARING' : 'READY'; order.version++;
  }
  return copy;
}

export default function KitchenPanel({ identity, locale, onConnectionChange }: { identity: Identity; locale: 'vi' | 'en'; onConnectionChange?: (connected: boolean) => void }) {
  const t = copy[locale]; const scope: KitchenScope = { tenantId: identity.tenantId, storeId: identity.storeId, userId: identity.userId };
  const scopeKey = `${scope.tenantId}:${scope.storeId}:${scope.userId}`;
  const [orders, setOrders] = useState<KitchenOrderSnapshot[]>([]); const [commands, setCommands] = useState<OfflineKitchenCommand[]>([]);
  const [online, setOnline] = useState(false); const [synchronizing, setSynchronizing] = useState(false); const [sessionExpired, setSessionExpired] = useState(false); const [storageError, setStorageError] = useState(false);
  const [deviceId, setDeviceId] = useState(''); const [lastSync, setLastSync] = useState(''); const busy = useRef(false); const socket = useRef<Socket | null>(null); const retryAfterBusy = useRef(false);
  const [authorizedDeviceId, setAuthorizedDeviceId] = useState('');
  const [enqueuingItems, setEnqueuingItems] = useState<string[]>([]);
  const enqueuingRef = useRef(new Set<string>());

  const refreshAuthoritative = useCallback(async (id: string) => {
    const rows = await request<Parameters<typeof kitchenOnly>[0][]>('/orders', undefined, id); const clean = rows.map(kitchenOnly).filter(order => order.status === 'ACCEPTED');
    await saveKitchenSnapshot(scope, clean); setOrders(clean); setLastSync(new Date().toISOString()); setSessionExpired(false);
  }, [scopeKey]);

  const synchronize = useCallback(async () => {
    if (busy.current) { retryAfterBusy.current = true; return; }
    if (!navigator.onLine) return;
    busy.current = true; setSynchronizing(true);
    try {
      const me = await request<Identity>('/auth/me');
      if (me.userId !== scope.userId || me.storeId !== scope.storeId || me.tenantId !== scope.tenantId || !['KITCHEN', 'OWNER', 'MANAGER'].includes(me.role)) throw new KitchenError(403, 'IDENTITY_CHANGED');
      window.dispatchEvent(new Event('omnihub:identity-verified'));
      const id = await getKitchenDeviceId(scope); setDeviceId(id);
      await request('/kitchen/devices/register', { deviceId: id });
      // A local device ID alone does not authorize the Socket.IO handshake.
      setAuthorizedDeviceId(id);
      if (socket.current && !socket.current.connected && !socket.current.active) socket.current.connect();
      await refreshAuthoritative(id);
      const pending = (await recoverKitchenCommands(scope)).filter(command => ['PENDING', 'SENDING'].includes(command.status)); setCommands(await readKitchenCommands(scope));
      if (pending.length) {
        const CHUNK_SIZE = 50;
        for (let offset = 0; offset < pending.length; offset += CHUNK_SIZE) {
          const chunk = pending.slice(offset, offset + CHUNK_SIZE);
          for (const command of chunk) await updateKitchenCommand(command.commandId, { status: 'SENDING' });
          setCommands(await readKitchenCommands(scope));
          try {
            const response = await request<{ results: { commandId: string; status: 'CONFIRMED' | 'CONFLICT' | 'REJECTED' | 'BLOCKED'; version?: number; code?: string }[] }>('/kitchen/sync', { commands: chunk.map(({ scope: _scope, status: _status, code: _code, ...command }) => command) }, id);
            for (const result of response.results) await updateKitchenCommand(result.commandId, { status: result.status, code: result.code });
          } catch (error) {
            for (const command of chunk) await updateKitchenCommand(command.commandId, { status: 'PENDING', code: error instanceof KitchenError ? error.code : 'NETWORK_RETRY' });
            if (error instanceof KitchenError && error.status === 401) { setSessionExpired(true); return; }
            throw error;
          }
          setCommands(await readKitchenCommands(scope));
        }
        await refreshAuthoritative(id);
      }
      await pruneKitchenCommands(scope).catch(() => undefined);
      setOnline(true);
      setCommands(await readKitchenCommands(scope));
    } catch (error) {
      if (error instanceof KitchenError && (error.status === 401 || error.status === 403)) { setSessionExpired(true); setAuthorizedDeviceId(''); }
      if (navigator.onLine && !(error instanceof KitchenError && error.status === 401)) setOnline(false);
    } finally { busy.current = false; setSynchronizing(false); if (retryAfterBusy.current) { retryAfterBusy.current = false; window.setTimeout(() => { void synchronize(); }, 0); } }
  }, [scopeKey, refreshAuthoritative]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [snapshot, savedCommands, id] = await Promise.all([readKitchenSnapshot(scope), recoverKitchenCommands(scope), getKitchenDeviceId(scope)]);
        if (!active) return; if (snapshot) { setOrders(snapshot.orders); setLastSync(snapshot.savedAt); }
        setCommands(savedCommands); setDeviceId(id);
        if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      } catch { setStorageError(true); }
    })();
    const onlineHandler = () => { setOnline(true); void synchronize(); }; const offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler); window.addEventListener('offline', offlineHandler); setOnline(navigator.onLine);
    window.addEventListener('omnihub:kitchen-refresh', onlineHandler);
    const interval = window.setInterval(() => { if (navigator.onLine) void synchronize(); }, 15_000);
    if (navigator.onLine) void synchronize();
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('online', onlineHandler); window.removeEventListener('offline', offlineHandler); window.removeEventListener('omnihub:kitchen-refresh', onlineHandler); };
  }, [scopeKey, synchronize]);

  useEffect(() => {
    if (!authorizedDeviceId) return;
    const channel = io(API, { auth: { deviceId: authorizedDeviceId }, withCredentials: true, reconnection: true, transports: ['websocket', 'polling'] }); socket.current = channel;
    channel.on('connect', () => { onConnectionChange?.(true); setOnline(true); void synchronize(); });
    channel.on('disconnect', reason => {
      onConnectionChange?.(false); setOnline(false);
      // Server disconnects do not auto-reconnect. Revalidate the device first;
      // assignment changes can reconnect, while revocation stays denied.
      if (reason === 'io server disconnect') void synchronize();
    });
    channel.on('connect_error', () => onConnectionChange?.(false));
    channel.on('operational.event', () => { void synchronize(); });
    return () => { channel.removeAllListeners(); channel.disconnect(); socket.current = null; onConnectionChange?.(false); };
  }, [authorizedDeviceId, synchronize, onConnectionChange]);

  const visibleOrders = useMemo(
    () => predict(orders, commands).filter(order => order.items.some(item => item.status !== 'HANDED_OFF' && item.status !== 'CANCELLED')),
    [orders, commands],
  );
  const unresolved = commands.filter(command => ['CONFLICT', 'REJECTED', 'BLOCKED'].includes(command.status));
  const pendingCount = commands.filter(command => ['PENDING', 'SENDING', 'CONFLICT', 'REJECTED', 'BLOCKED'].includes(command.status)).length;
  const queue = async (order: KitchenOrderSnapshot, itemId: string, action: OfflineAction) => {
    if (enqueuingRef.current.has(itemId)) return;
    enqueuingRef.current.add(itemId);
    setEnqueuingItems(prev => [...prev, itemId]);
    try {
      const id = deviceId || await getKitchenDeviceId(scope); setDeviceId(id);
      const command = await enqueueKitchenCommand(scope, id, order.id, itemId, order.version, action);
      setCommands(await readKitchenCommands(scope));
      if (navigator.onLine) void synchronize();
      else setCommands(rows => rows.some(row => row.commandId === command.commandId) ? rows : [...rows, command]);
    } catch { setStorageError(true); }
    finally {
      enqueuingRef.current.delete(itemId);
      setEnqueuingItems(prev => prev.filter(id => id !== itemId));
    }
  };
  const acknowledgeOrder = async (orderId: string) => {
    for (const command of unresolved.filter(row => row.orderId === orderId)) await reviewKitchenCommand(command.commandId);
    setCommands(await readKitchenCommands(scope));
  };

  return <section className="kitchenBoard" aria-label={locale === 'vi' ? 'Màn hình bếp' : 'Kitchen display'}>
    <div className={`kitchenSync ${online ? 'isOnline' : 'isOffline'}`} role="status"><strong>{online ? t.online : t.offline}</strong><span>{!online && t.offlineHint}</span><span>{synchronizing ? t.syncing : pendingCount ? `${pendingCount} ${t.pending}` : t.synced}</span><button className="secondary" disabled={synchronizing} onClick={() => void synchronize()}>{t.retry}</button></div>
    {lastSync && <p className="kitchenLastSync">{t.lastSync}: {new Date(lastSync).toLocaleString(locale)}</p>}
    {sessionExpired && <p className="error" role="alert">{t.session}</p>}{storageError && <p className="error" role="alert">{t.storage}</p>}
    {unresolved.length > 0 && <section className="kitchenConflicts" aria-label={t.conflict}><h2>{t.conflict} · {unresolved.length}</h2>{unresolved.map(command => <article key={command.commandId}><strong>{command.action} · #{command.orderId.slice(0, 8)}</strong><p>{command.code ?? t.expected} · {command.status === 'BLOCKED' ? t.blocked : command.status === 'REJECTED' ? t.rejected : t.expected}</p><button className="secondary" onClick={() => void acknowledgeOrder(command.orderId)}>{t.review}</button></article>)}</section>}
    <div className="kitchenTickets">{visibleOrders.map(order => <article className="kitchenTicket" key={order.id}><header><strong>#{order.id.slice(0, 8)}</strong><time>{new Date(order.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time></header>{order.items.filter(item => item.status !== 'HANDED_OFF' && item.status !== 'CANCELLED').map(item => {
      const station = order.tickets.find(ticket => ticket.id === item.ticketId)?.station.name ?? '';
      const pendingCommand = commands.find(command => command.itemId === item.id && ['PENDING', 'SENDING'].includes(command.status));
      return <div className="kitchenTicketItem" key={item.id}><div><h3>{item.name}</h3><p>{station} · {itemLabel(item.status, locale === 'vi')}</p>{item.preparationNote && <p className="kitchenNote">{item.preparationNote}</p>}{pendingCommand && <small>{t.queued}</small>}</div><div className="kitchenTicketActions">{item.status === 'PENDING' && <button disabled={enqueuingItems.includes(item.id)} onClick={() => void queue(order, item.id, 'START')}>{t.start}</button>}{item.status === 'PREPARING' && <button disabled={enqueuingItems.includes(item.id)} onClick={() => void queue(order, item.id, 'READY')}>{t.ready}</button>}</div></div>;
    })}</article>)}{!visibleOrders.length && <p className="empty">{t.empty}</p>}</div>
  </section>;
}
