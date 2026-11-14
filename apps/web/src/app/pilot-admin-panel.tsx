'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Locale = 'vi' | 'en';
type Station = { id: string; name: string };
type Activity = { action: string; createdAt: string; details: unknown };
type Device = { id: string; email: string; station: Station | null; createdAt: string; lastSeenAt: string; revokedAt: string | null; sessionExpiresAt: string | null; activity: Activity[] };
type Invite = { id: string; email: string; role: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; status: string };
type Ready = { store: { name: string; timezone: string; dayStart: number; qrOrderingEnabled: boolean }; checks: { storeConfigured: boolean; employees: number; stations: number; activeProducts: number; productsWithRecipes: number; ingredients: number; openingBalances: number; registers: number; qrOrderingEnabled: boolean; activeQrTables: number; activeKitchenDevices: number } };

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const t = {
  vi: { title: 'Sẵn sàng vận hành thử', reload: 'Làm mới', devices: 'Thiết bị bếp', assign: 'Trạm bếp', allStations: 'Tất cả trạm', revoke: 'Thu hồi', revoked: 'Đã thu hồi', session: 'Phiên hết hạn', activity: 'Hoạt động', invites: 'Mời nhân viên', email: 'Email nhân viên', role: 'Vai trò', send: 'Tạo lời mời', copy: 'Sao chép liên kết', copied: 'Đã sao chép', inviteLink: 'Liên kết chỉ hiển thị một lần. Gửi riêng cho nhân viên.', pending: 'Đang chờ', revokeInvite: 'Thu hồi lời mời', expired: 'Hết hạn', accepted: 'Đã tham gia', ready: 'Đạt', missing: 'Cần hoàn tất', error: 'Không thể tải hoặc lưu thay đổi.', status: 'Trạng thái', business: 'Cấu hình cửa hàng', employees: 'Nhân viên đã gán', stations: 'Trạm bếp hoạt động', products: 'Món đang bán', recipes: 'Món có công thức', ingredients: 'Nguyên liệu', inventory: 'Có tồn kho đầu kỳ', registers: 'Quầy thu ngân', devicesReady: 'Thiết bị bếp chưa thu hồi', qr: 'QR đã bật', qrTables: 'Bàn QR hoạt động', owner: 'Quản lý', manager: 'Quản lý cửa hàng', cashier: 'Thu ngân', kitchen: 'Bếp', inventoryRole: 'Kho' },
  en: { title: 'Pilot readiness', reload: 'Refresh', devices: 'Kitchen devices', assign: 'Kitchen station', allStations: 'All stations', revoke: 'Revoke', revoked: 'Revoked', session: 'Session expires', activity: 'Activity', invites: 'Invite employee', email: 'Employee email', role: 'Role', send: 'Create invitation', copy: 'Copy invite link', copied: 'Copied', inviteLink: 'The link is shown once. Send it privately to the employee.', pending: 'Pending', revokeInvite: 'Revoke invitation', expired: 'Expired', accepted: 'Joined', ready: 'Ready', missing: 'Needs setup', error: 'Could not load or save the changes.', status: 'Status', business: 'Store configuration', employees: 'Assigned employees', stations: 'Active kitchen stations', products: 'Active products', recipes: 'Products with recipes', ingredients: 'Ingredients', inventory: 'Opening stock exists', registers: 'Cash registers', devicesReady: 'Active kitchen devices', qr: 'QR ordering enabled', qrTables: 'Active QR tables', owner: 'Manager', manager: 'Store manager', cashier: 'Cashier', kitchen: 'Kitchen', inventoryRole: 'Inventory' },
};
const roleNames = (locale: Locale) => ({ MANAGER: t[locale].manager, CASHIER: t[locale].cashier, KITCHEN: t[locale].kitchen, INVENTORY: t[locale].inventoryRole });

export default function PilotAdminPanel({ locale }: { locale: Locale }) {
  const words = t[locale];
  const [readiness, setReadiness] = useState<Ready | null>(null); const [stations, setStations] = useState<Station[]>([]); const [devices, setDevices] = useState<Device[]>([]); const [invitations, setInvitations] = useState<Invite[]>([]);
  const [inviteUrl, setInviteUrl] = useState(''); const [copied, setCopied] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const call = useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${API}${path}`, { method, credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.code ?? 'REQUEST_FAILED'); return payload as T;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [ready, deviceRows, inviteRows] = await Promise.all([call<Ready>('/admin/pilot-readiness'), call<{ stations: Station[]; devices: Device[] }>('/admin/kitchen/devices'), call<Invite[]>('/admin/invitations')]);
      setReadiness(ready); setStations(deviceRows.stations); setDevices(deviceRows.devices); setInvitations(inviteRows); setError('');
    } catch { setError(words.error); }
  }, [call, words.error]);
  useEffect(() => { void refresh(); }, [refresh]);
  const changeStation = async (device: Device, stationId: string) => {
    setBusy(true); try { await call(`/admin/kitchen/devices/${device.id}/assignment`, 'PUT', { stationId: stationId || null }); await refresh(); } catch { setError(words.error); } finally { setBusy(false); }
  };
  const revokeDevice = async (device: Device) => {
    if (!window.confirm(locale === 'vi' ? 'Thu hồi thiết bị này? Thiết bị sẽ không thể đồng bộ lệnh bếp.' : 'Revoke this device? It will no longer synchronize kitchen commands.')) return;
    setBusy(true); try { await call(`/admin/kitchen/devices/${device.id}/revoke`, 'POST', {}); await refresh(); } catch { setError(words.error); } finally { setBusy(false); }
  };
  const createInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); const formElement = event.currentTarget; const form = new FormData(formElement);
    try { const result = await call<{ token: string }>('/admin/invitations', 'POST', { email: String(form.get('email')), role: String(form.get('role')) }); setInviteUrl(`${window.location.origin}/invite/${result.token}`); formElement.reset(); await refresh(); } catch { setError(words.error); } finally { setBusy(false); }
  };
  const revokeInvite = async (invite: Invite) => { setBusy(true); try { await call(`/admin/invitations/${invite.id}/revoke`, 'POST', {}); await refresh(); } catch { setError(words.error); } finally { setBusy(false); } };
  const checklist = readiness ? [
    [words.business, readiness.checks.storeConfigured, readiness.store.name], [words.employees, readiness.checks.employees >= 2, String(readiness.checks.employees)], [words.stations, readiness.checks.stations > 0, String(readiness.checks.stations)], [words.products, readiness.checks.activeProducts > 0, String(readiness.checks.activeProducts)], [words.recipes, readiness.checks.productsWithRecipes >= readiness.checks.activeProducts && readiness.checks.activeProducts > 0, `${readiness.checks.productsWithRecipes}/${readiness.checks.activeProducts}`], [words.ingredients, readiness.checks.ingredients > 0, String(readiness.checks.ingredients)], [words.inventory, readiness.checks.openingBalances > 0, String(readiness.checks.openingBalances)], [words.registers, readiness.checks.registers > 0, String(readiness.checks.registers)], [words.devicesReady, readiness.checks.activeKitchenDevices > 0, String(readiness.checks.activeKitchenDevices)], [words.qr, readiness.checks.qrOrderingEnabled, readiness.checks.qrOrderingEnabled ? words.ready : words.missing], [words.qrTables, readiness.checks.activeQrTables > 0, String(readiness.checks.activeQrTables)],
  ] as const : [];
  return <section className="adminPanel pilotAdmin"><header className="sectionHeading"><div><p className="eyebrow">OMNIHUB / PILOT</p><h2>{words.title}</h2></div><button className="secondary" onClick={() => void refresh()}>{words.reload}</button></header>
    {error && <p className="error" role="alert">{error}</p>}
    {readiness && <div className="pilotChecklist">{checklist.map(([label, complete, value]) => <article key={label} className="adminRow"><span><strong>{label}</strong><small>{value}</small></span><strong className={complete ? 'readyBadge' : 'pendingBadge'}>{complete ? words.ready : words.missing}</strong></article>)}</div>}
    <h3>{words.devices}</h3><div className="adminList">{devices.map(device => <article key={device.id} className="adminRow pilotDevice"><div><strong>{device.email}</strong><small>{device.id} · {locale === 'vi' ? 'Lần cuối' : 'Last seen'}: {new Date(device.lastSeenAt).toLocaleString(locale)} · {words.session}: {device.sessionExpiresAt ? new Date(device.sessionExpiresAt).toLocaleString(locale) : '—'}</small>{device.activity.slice(0, 5).map((event, index) => <small key={`${event.action}-${index}`}>{event.action} · {new Date(event.createdAt).toLocaleString(locale)}</small>)}</div><div className="adminActions"><label>{words.assign}<select aria-label={`${words.assign} ${device.email}`} value={device.station?.id ?? ''} disabled={busy || !!device.revokedAt} onChange={event => void changeStation(device, event.target.value)}><option value="">{words.allStations}</option>{stations.map(station => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>{device.revokedAt ? <span className="pendingBadge">{words.revoked}</span> : <button className="textButton danger" disabled={busy} onClick={() => void revokeDevice(device)}>{words.revoke}</button>}</div></article>)}{!devices.length && <p className="empty">{words.missing}</p>}</div>
    <h3>{words.invites}</h3><form className="adminForm" onSubmit={createInvite}><label>{words.email}<input type="email" name="email" required maxLength={254}/></label><label>{words.role}<select name="role"><option value="CASHIER">{words.cashier}</option><option value="KITCHEN">{words.kitchen}</option><option value="INVENTORY">{words.inventoryRole}</option><option value="MANAGER">{words.manager}</option></select></label><button disabled={busy}>{words.send}</button></form>
    {inviteUrl && <div className="adminRow inviteLink"><div><strong>{words.inviteLink}</strong><small>{inviteUrl}</small></div><button className="secondary" onClick={() => { void navigator.clipboard.writeText(inviteUrl).then(() => setCopied(true)); }}>{copied ? words.copied : words.copy}</button></div>}
    <div className="adminList">{invitations.map(invite => <article key={invite.id} className="adminRow"><div><strong>{invite.email}</strong><small>{roleNames(locale)[invite.role as keyof ReturnType<typeof roleNames>] ?? invite.role} · {new Date(invite.expiresAt).toLocaleString(locale)}</small></div><div className="adminActions"><span className={invite.status === 'PENDING' ? 'pendingBadge' : 'readyBadge'}>{invite.status === 'PENDING' ? words.pending : invite.status === 'ACCEPTED' ? words.accepted : invite.status}</span>{invite.status === 'PENDING' && <button className="textButton danger" disabled={busy} onClick={() => void revokeInvite(invite)}>{words.revokeInvite}</button>}</div></article>)}</div>
  </section>;
}
