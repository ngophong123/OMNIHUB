'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { en, vi, type Dictionary } from './i18n';
import AdminPanel from './admin-panel';
import CashPanel from './cash-panel';
import PilotAdminPanel from './pilot-admin-panel';
import QrTablesPanel from './qr-tables-panel';
import KitchenPanel from './kitchen-panel';
import { clearKitchenSnapshot, forgetKitchenIdentity, readKitchenIdentity, rememberKitchenIdentity } from './kitchen-offline';

type Me = { userId: string; tenantId: string; role: string; storeName: string; storeId: string };
type Product = { id: string; name: string; price: number; available?: boolean; variants?: { id: string; name: string; price: number; available?: boolean }[]; modifierGroups?: { id: string; name: string; minSelections: number; maxSelections: number; options: { id: string; name: string; priceDelta: number }[] }[] };
type CartLine = { key: string; productId: string; name: string; quantity: number; unitPrice: number; variantId?: string; modifierIds: string[] };
type Item = { id: string; name: string; status: string; unitPrice: number; ticketId: string; preparationNote?: string };
type Order = { id: string; status: string; paymentStatus: string; total: number; version: number; items: Item[]; createdAt: string; tickets: { id: string; station: { name: string } }[]; payments: { id: string; amount: number; tendered: number; change: number; method: string; status: string; externalReference: string | null; splitId: string | null }[]; refunds: { id: string; paymentId: string; amount: number; reason: string; status: string }[]; billSplits: { id: string; label: string; amount: number }[] };
type Stock = { ingredientId: string; onHand: string; reserved: string; available: string; ingredient: { name: string; unit: string } };
type Report = { businessDate: string; _sum: { amount: number }; _count: { id: number }; refunds?: number; net?: number };
type Movement = { id: string; kind: string; ingredientId: string; onHandDelta: string; reservedDelta: string; createdAt: string };
type Tab = 'pos' | 'orders' | 'kitchen' | 'inventory' | 'cash' | 'reports' | 'admin';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
class ApiError extends Error { constructor(public code: string, public status: number) { super(code); } }
async function api<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) }) });
  const data: unknown = await response.json();
  if (!response.ok) throw new ApiError((data as { code?: string }).code ?? 'SERVICE_UNAVAILABLE', response.status);
  return data as T;
}
function message(error: unknown, t: Dictionary): string {
  if (!(error instanceof ApiError)) return t.service;
  if (error.status === 401) return error.code === 'INVALID_CREDENTIALS' ? t.credentials : t.session;
  if (error.status === 403) return t.denied;
  if (error.code === 'INSUFFICIENT_STOCK') return t.stockError;
  if (error.code === 'INSUFFICIENT_CASH') return t.cashError;
  return error.status === 409 ? t.stale : error.status === 400 ? t.invalid : t.service;
}

function RefundActions({ order, locale, admin, busy, mutate, money }: { order: Order; locale: 'vi'|'en'; admin: boolean; busy: boolean; mutate: (path: string, body: unknown) => Promise<void>; money: (n: number) => string; labelStatus: (value: string) => string }) {
  const t = locale === 'vi' ? vi : en;
  const settled = order.payments.filter(payment => payment.status === 'SETTLED');
  return <>
    {settled.length > 0 && <form className="cash" aria-label={t.refund} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); const itemId = String(form.get('itemId') ?? ''); void mutate(`/payments/${String(form.get('paymentId'))}/refunds`, { amount: Number(form.get('amount')), reason: String(form.get('reason')), ...(itemId ? { itemId } : {}) }); }}>
      <label>{t.originalPayment}<select name="paymentId" required>{settled.map(payment => <option key={payment.id} value={payment.id}>{payment.method} · {money(payment.amount)}</option>)}</select></label>
      <label>{t.refundAmount}<input name="amount" type="number" min="1" max="1000000000" step="1" required/></label>
      <label>{t.refundItem}<select name="itemId"><option value="">{t.wholePayment}</option>{order.items.filter(item => item.status !== 'CANCELLED').map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.unitPrice)}</option>)}</select></label>
      <label>{t.refundReason}<input name="reason" minLength={5} maxLength={300} required/></label>
      <button disabled={busy}>{t.requestRefund}</button>
    </form>}
    {admin && order.payments.filter(payment => payment.status === 'PENDING').map(payment => <button className="textButton danger" key={`fail-${payment.id}`} disabled={busy} onClick={() => { const reason = window.prompt(t.paymentFailureReason); if (reason) void mutate(`/payments/${payment.id}/fail`, { reason }); }}>{t.markFailed} · {payment.externalReference}</button>)}
  </>;
}

function OrderCancelAction({ order, locale, busy, mutate }: { order: Order; locale: 'vi'|'en'; busy: boolean; mutate: (path: string, body: unknown) => Promise<void> }) {
  const t = locale === 'vi' ? vi : en;
  if (order.status !== 'ACCEPTED' || order.paymentStatus !== 'UNPAID') return null;
  return <button className="textButton danger" disabled={busy} onClick={() => { if (!window.confirm(t.confirmCancelOrder)) return; const reason = window.prompt(t.cancelReason); if (!reason || reason.trim().length < 5) return; void mutate(`/orders/${order.id}/cancel`, { expectedVersion: order.version, reason }); }}>{t.cancelOrder}</button>;
}

export default function Home() {
  const [locale, setLocale] = useState<'vi' | 'en'>('vi'); const t = locale === 'vi' ? vi : en;
  const [me, setMe] = useState<Me | null>(null); const [booting, setBooting] = useState(true);
  const [cachedKitchenIdentity, setCachedKitchenIdentity] = useState(false);
  const [tab, setTab] = useState<Tab>('pos'); const [products, setProducts] = useState<Product[]>([]); const [orders, setOrders] = useState<Order[]>([]);
  const [stock, setStock] = useState<Stock[]>([]); const [reports, setReports] = useState<Report[]>([]); const [movements, setMovements] = useState<Movement[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]); const [customizing, setCustomizing] = useState<Product | null>(null); const [variantId, setVariantId] = useState(''); const [modifierIds, setModifierIds] = useState<string[]>([]); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const lock = useRef(false); const pending = useRef<{ signature: string; key: string } | null>(null);
  const [connected, setConnected] = useState(false); const [loading, setLoading] = useState(false);
  const money = (n: number) => new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(n);
  const can = (roles: string[]) => !!me && roles.includes(me.role);
  const admin = !!me && ['OWNER', 'MANAGER'].includes(me.role);
  const addProduct = (product: Product, selectedVariantId?: string, selectedModifierIds: string[] = []) => {
    const variant = product.variants?.find(v => v.id === selectedVariantId);
    const modifiers = product.modifierGroups?.flatMap(g => g.options.filter(o => selectedModifierIds.includes(o.id))) ?? [];
    const key = `${product.id}:${variant?.id ?? ''}:${[...selectedModifierIds].sort().join(',')}`;
    const name = [product.name, variant?.name, ...modifiers.map(m => m.name)].filter(Boolean).join(' · ');
    const unitPrice = (variant?.price ?? product.price) + modifiers.reduce((sum, m) => sum + m.priceDelta, 0);
    setCart(lines => { const line = lines.find(l => l.key === key); return line ? lines.map(l => l.key === key ? { ...l, quantity: l.quantity + 1 } : l) : [...lines, { key, productId: product.id, name, quantity: 1, unitPrice, ...(variant ? { variantId: variant.id } : {}), modifierIds: selectedModifierIds }]; });
    setCustomizing(null); setVariantId(''); setModifierIds([]);
  };
  const selectProduct = async (product: Product) => {
    setBusy(true);
    try {
      // An administrator can change modifiers while POS is open. Use the
      // current catalog before showing prices and choices in the cart.
      const currentCatalog = await api<Product[]>('/catalog');
      setProducts(currentCatalog);
      const current = currentCatalog.find(row => row.id === product.id);
      if (!current || current.available === false) { setError(t.inactive); return; }
      if ((current.variants?.length ?? 0) || (current.modifierGroups?.length ?? 0)) {
        setCustomizing(current); setVariantId(''); setModifierIds([]);
      } else addProduct(current);
    } catch (error) { setError(message(error, t)); }
    finally { setBusy(false); }
  };
  const changeCart = (key: string, delta: number) => setCart(lines => lines.map(l => l.key === key ? { ...l, quantity: l.quantity + delta } : l).filter(l => l.quantity > 0));
  useEffect(() => {
    const l = localStorage.getItem('omnihub.locale'); if (l === 'en') setLocale(l);
    const verified = () => setCachedKitchenIdentity(false); window.addEventListener('omnihub:identity-verified', verified);
    void (async () => {
      try {
        if (!navigator.onLine) {
          const cached = await readKitchenIdentity().catch(() => undefined);
          if (cached && ['KITCHEN', 'OWNER', 'MANAGER'].includes(cached.role)) { setMe(cached); setCachedKitchenIdentity(true); setTab('kitchen'); }
          return;
        }
        const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 2000);
        let identity: Me;
        try {
          const response = await fetch(`${API}/auth/me`, { credentials: 'include', cache: 'no-store', signal: controller.signal }); const payload = await response.json();
          if (!response.ok) throw new ApiError(payload.code ?? 'SERVICE_UNAVAILABLE', response.status); identity = payload as Me;
        } finally { window.clearTimeout(timeout); }
        setMe(identity); setCachedKitchenIdentity(false); if (identity.role === 'KITCHEN') setTab('kitchen'); void rememberKitchenIdentity(identity);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return;
        const cached = await readKitchenIdentity().catch(() => undefined);
        if (cached && ['KITCHEN', 'OWNER', 'MANAGER'].includes(cached.role)) { setMe(cached); setCachedKitchenIdentity(true); setTab('kitchen'); }
      } finally { setBooting(false); }
    })();
    return () => window.removeEventListener('omnihub:identity-verified', verified);
  }, []);
  useEffect(() => { document.documentElement.lang = locale; localStorage.setItem('omnihub.locale', locale); }, [locale]);
  const load = useCallback(async () => {
    if (!me) return;
    if (me.role === 'KITCHEN') { setLoading(false); return; }
    setLoading(true);
    try {
      const [catalog, currentOrders] = await Promise.all([api<Product[]>('/catalog'), api<Order[]>('/orders')]);
      setProducts(catalog); setOrders(currentOrders);
      if (['OWNER', 'MANAGER', 'INVENTORY'].includes(me.role)) {
        const [s, m] = await Promise.all([api<Stock[]>('/inventory'), api<Movement[]>('/inventory/movements')]); setStock(s); setMovements(m);
      }
      if (['OWNER', 'MANAGER'].includes(me.role)) setReports(await api<Report[]>('/reports/daily'));
    } catch (e) { setError(message(e, t)); if (e instanceof ApiError && e.status === 401) setMe(null); }
    finally { setLoading(false); }
  }, [me, t]);
  useEffect(() => {
    if (!me || me.role === 'KITCHEN') return;
    void load();
    const socket = io(API, { withCredentials: true });
    socket.on('connect', () => { setConnected(true); void load(); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('operational.event', () => { void load(); });
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => { socket.disconnect(); clearInterval(timer); };
  }, [me, load]);
  async function mutate(path: string, body: unknown, success?: () => void) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    const signature = JSON.stringify({ path, body });
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    try { await api(path, body, pending.current.key); pending.current = null; success?.(); setNotice('success'); await load(); }
    catch (e) { setError(message(e, t)); if (e instanceof ApiError && e.status < 500) pending.current = null; }
    finally { lock.current = false; setBusy(false); }
  }
  const language = <label className="language"><span>{t.language}</span><select aria-label={t.language} value={locale} onChange={e => setLocale(e.target.value as 'vi' | 'en')}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label>;
  if (booting) return <main className="login"><p role="status">{t.loading}</p></main>;
  if (!me) return <main className="login"><section className="loginBrand"><div className="logo">O<span>H</span></div><p className="eyebrow">OMNIHUB</p><h1>{t.tagline}</h1><div className="brandLines" aria-hidden="true"><i/><i/><i/></div></section><section className="loginForm">{language}<h2>{t.login}</h2><p>{t.loginHint}</p><form onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(''); void api('/auth/login', { email: form.get('email'), password: form.get('password'), storeId: form.get('storeId') }).then(() => api<Me>('/auth/me')).then(m => { setMe(m); void rememberKitchenIdentity(m); setTab(['KITCHEN'].includes(m.role) ? 'kitchen' : m.role === 'INVENTORY' ? 'inventory' : 'pos'); }).catch(err => setError(message(err, t))).finally(() => setBusy(false)); }}>
    <label>{t.email}<input name="email" type="email" required autoComplete="username"/></label><label>{t.password}<input name="password" type="password" required autoComplete="current-password"/></label><label>{t.storeId}<input name="storeId" required pattern="[a-fA-F0-9\-]{36}"/></label><button disabled={busy}>{busy ? t.busy : t.login}</button></form>{error && <p role="alert" className="error">{error}</p>}</section></main>;
  const tabs: Tab[] = cachedKitchenIdentity ? ['kitchen'] : [...(can(['OWNER', 'MANAGER', 'CASHIER']) ? ['pos' as const] : []), 'orders', 'kitchen', ...(can(['OWNER', 'MANAGER', 'INVENTORY']) ? ['inventory' as const] : []), ...(can(['OWNER', 'MANAGER', 'CASHIER']) ? ['cash' as const] : []), ...(admin ? ['admin' as const, 'reports' as const] : [])];
  const labelStatus = (s: string) => t[s as keyof Dictionary] ?? s;
  return <div className="shell"><aside><a className="wordmark" href="/">OMNI<span>HUB</span><small>OPERATIONS</small></a><div className="store"><span className="dot"/>{me.storeName}<small>{me.role}</small></div><nav>{tabs.map((item, i) => <button key={item} className={tab === item ? 'nav active' : 'nav'} onClick={() => setTab(item)}><span className="navNumber">0{i + 1}</span>{t[item]}</button>)}</nav><div className="sidebarBottom"><small>{t.local}</small><button className="secondary" onClick={() => { const clear = async () => { await clearKitchenSnapshot(me); await forgetKitchenIdentity(); setCachedKitchenIdentity(false); setMe(null); setOrders([]); setProducts([]); setStock([]); setReports([]); setMovements([]); setCart([]); pending.current = null; setError(''); setNotice(''); }; if (cachedKitchenIdentity) void clear(); else void api('/auth/logout', {}).then(clear).catch(e => setError(message(e, t))); }}>{t.logout}</button></div></aside>
    <main className="workspace"><header><div><p className="eyebrow">OMNIHUB / {me.storeName}</p><h1>{t[tab]}</h1></div>{language}</header><div className="connection"><span className={connected ? 'dot' : 'dot warning'}/><span>{connected ? t.connected : t.reconnecting}</span><button className="textButton" onClick={() => { setError(''); if (me.role === 'KITCHEN') window.dispatchEvent(new Event('omnihub:kitchen-refresh')); else void load(); }}>{loading ? t.loading : t.refresh}</button></div>
      <div aria-live="polite">{error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{t.success}</p>}</div>
      {tab === 'pos' && <div className="posGrid"><section><h2>{t.menu}<small>{products.length}</small></h2><div className="products">{products.map((p, i) => <button className="product" key={p.id} disabled={busy || p.available === false} onClick={() => { void selectProduct(p); }}><span className="productIndex">{String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong><span>{money(p.price)}</span><span className="plus">+</span>{p.available === false && <small>{t.inactive}</small>}</button>)}</div>{!products.length && <p>{t.empty}</p>}</section><section className="cart"><h2>{t.cart}</h2>{cart.map(line => <div className="cartRow" key={line.key}><div><strong>{line.name}</strong><small>{money(line.unitPrice)}</small></div><div className="quantity"><button className="secondary" aria-label={`${t.remove} ${line.name}`} onClick={() => changeCart(line.key, -1)}>−</button><span>{line.quantity}</span><button className="secondary" aria-label={`${t.add} ${line.name}`} onClick={() => changeCart(line.key, 1)}>+</button></div></div>)}{!cart.length && <p className="empty">{t.emptyCart}</p>}<div className="cartTotal"><span>{t.total}</span><strong>{money(cart.reduce((s, line) => s + line.unitPrice * line.quantity, 0))}</strong></div><button disabled={busy || !cart.length} onClick={() => { void mutate('/orders', { lines: cart.map(line => ({ productId: line.productId, quantity: line.quantity, ...(line.variantId ? { variantId: line.variantId } : {}), ...(line.modifierIds.length ? { modifierIds: line.modifierIds } : {}) })) }, () => { setCart([]); setTab('orders'); }); }}>{busy ? t.busy : t.accept}</button></section></div>}
      {customizing && <div className="modalBackdrop"><section className="customizer" role="dialog" aria-modal="true" aria-labelledby="customizer-title"><h2 id="customizer-title">{customizing.name}</h2>{(customizing.variants?.length ?? 0) > 0 && <label>{locale === 'vi' ? 'Kích cỡ' : 'Variant'}<select value={variantId} onChange={e => setVariantId(e.target.value)}><option value="">{locale === 'vi' ? 'Mặc định' : 'Standard'} · {money(customizing.price)}</option>{customizing.variants?.map(v => <option key={v.id} value={v.id} disabled={v.available === false}>{v.name} · {money(v.price)}{v.available === false ? ` · ${t.inactive}` : ''}</option>)}</select></label>}{customizing.modifierGroups?.map(group => <fieldset key={group.id}><legend>{group.name} ({group.minSelections}–{group.maxSelections})</legend>{group.options.map(option => { const checked = modifierIds.includes(option.id); const groupCount = group.options.filter(o => modifierIds.includes(o.id)).length; return <label className="modifierChoice" key={option.id}><input type="checkbox" checked={checked} disabled={!checked && groupCount >= group.maxSelections} onChange={() => setModifierIds(ids => checked ? ids.filter(id => id !== option.id) : [...ids, option.id])}/>{option.name} · +{money(option.priceDelta)}</label>; })}</fieldset>)}<div className="adminActions"><button disabled={variantId !== '' && customizing.variants?.find(v => v.id === variantId)?.available === false} onClick={() => { const invalid = customizing.modifierGroups?.some(g => { const n = g.options.filter(o => modifierIds.includes(o.id)).length; return n < g.minSelections || n > g.maxSelections; }); if (invalid) { setError(locale === 'vi' ? 'Chọn đủ số tùy chọn bắt buộc.' : 'Choose the required number of options.'); return; } addProduct(customizing, variantId || undefined, modifierIds); }}>{t.add}</button><button className="secondary" onClick={() => setCustomizing(null)}>{t.close}</button></div></section></div>}
      {tab === 'orders' && <div className="orderGrid">{orders.map(o => <article className="orderCard" key={o.id}><div className="orderHead"><strong>#{o.id.slice(0, 8)}</strong><span className={`badge ${o.status.toLowerCase()}`}>{labelStatus(o.status)}</span></div><div className="orderMeta"><time>{new Date(o.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time><span>{labelStatus(o.paymentStatus)}</span></div>{o.items.map(item => <div key={item.id} className="orderLine"><div><strong>{item.name}</strong><small>{o.tickets.find(ticket => ticket.id === item.ticketId)?.station.name} · {labelStatus(item.status)}{item.preparationNote ? ` · ${item.preparationNote}` : ''}</small></div><div className="actions">{(['START', 'READY', 'HANDOFF', 'CANCEL'] as const).filter(action => {
        if (o.status !== 'ACCEPTED') return false;
        if (action === 'START') return item.status === 'PENDING' && can(['OWNER', 'MANAGER', 'KITCHEN']);
        if (action === 'READY') return item.status === 'PREPARING' && can(['OWNER', 'MANAGER', 'KITCHEN']);
        if (action === 'HANDOFF') return item.status === 'READY' && can(['OWNER', 'MANAGER', 'KITCHEN', 'CASHIER']);
        return item.status !== 'CANCELLED' && (admin || (item.status === 'PENDING' && me.role === 'CASHIER'));
      }).map(action => <button className={action === 'CANCEL' ? 'textButton danger' : 'smallButton'} disabled={busy} key={action} onClick={() => { if (action === 'CANCEL' && !window.confirm(t.confirmCancel)) return; void mutate(`/items/${item.id}/commands`, { action, expectedVersion: o.version }); }}>{t[action]}</button>)}</div></div>)}<div className="cartTotal"><span>{t.total}</span><strong>{money(o.total)}</strong></div><OrderCancelAction order={o} locale={locale} busy={busy} mutate={mutate}/><small>{t.remaining}: {money(Math.max(0, o.total - o.payments.filter(p => p.status === 'SETTLED').reduce((sum, payment) => sum + payment.amount, 0)))}</small><div className="paymentHistory"><strong>{t.paymentHistory}</strong>{o.payments.map(p => <div className="orderLine" key={p.id}><span>{p.method} · {p.status === 'PENDING' ? t.awaitingVerification : labelStatus(p.status)} · {money(p.amount)}{p.method === 'CASH' && p.change > 0 ? ` · ${t.change}: ${money(p.change)}` : ''}{p.externalReference ? ` · ${p.externalReference}` : ''}</span>{admin && p.status === 'PENDING' && <button className="smallButton" disabled={busy} onClick={() => void mutate(`/payments/${p.id}/verify`, {})}>{t.verify}</button>}</div>)}{tab === 'orders' && <RefundActions order={o} locale={locale} admin={admin} busy={busy} mutate={mutate} money={money} labelStatus={labelStatus}/ >}{o.refunds.map(r => <div className="orderLine" key={r.id}><span>{t.refund} · {labelStatus(r.status)} · {money(r.amount)} · {r.reason}</span>{admin && r.status === 'REQUESTED' && <button className="smallButton" disabled={busy} onClick={() => void mutate(`/refunds/${r.id}/decision`, { decision: 'APPROVED', reason: locale === 'vi' ? 'Quản lý duyệt hoàn tiền' : 'Manager approved refund' })}>{t.approveRefund}</button>}</div>)}</div>{tab === 'orders' && o.status === 'ACCEPTED' && can(['OWNER', 'MANAGER', 'CASHIER']) && <><form className="cash" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const method = String(data.get('method')); const amount = Number(data.get('amount')); const tendered = Number(data.get('tendered')); const externalReference = String(data.get('externalReference') ?? '').trim(); const splitId = String(data.get('splitId') ?? ''); void mutate(`/orders/${o.id}/payments`, { method, amount, ...(method === 'CASH' ? { tendered } : {}), ...(method === 'BANK_TRANSFER' ? { externalReference } : {}), ...(splitId ? { splitId } : {}) }); }}><label>{t.paymentMethod}<select name="method"><option value="CASH">{t.cashMethod}</option><option value="BANK_TRANSFER">{t.bankTransfer}</option><option value="CARD" disabled>{t.cardDisabled}</option></select></label><label>{t.paymentAmount}<input name="amount" type="number" min="1" max={Math.max(1, o.total - o.payments.filter(p => p.status === 'SETTLED').reduce((s,p) => s + p.amount, 0))} step="1" required defaultValue={Math.max(1, o.total - o.payments.filter(p => p.status === 'SETTLED').reduce((s,p) => s + p.amount, 0))}/></label><label>{t.tendered}<input name="tendered" type="number" min="1" max="1_000_000_000" step="1" defaultValue={o.total}/></label><label>{t.bankReference}<input name="externalReference" maxLength={120}/></label><label>{t.splitAllocation}<select name="splitId"><option value="">{t.unallocated}</option>{o.billSplits.map(s => <option key={s.id} value={s.id}>{s.label} · {money(s.amount)}</option>)}</select></label><button disabled={busy || o.items.some(i => !['HANDED_OFF', 'CANCELLED'].includes(i.status))}>{t.recordPayment}</button></form><form className="cash" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const itemIds = data.getAll('itemIds').map(String); const amount = Number(data.get('splitAmount')); const label = String(data.get('splitLabel')); void mutate(`/orders/${o.id}/splits`, { label, ...(itemIds.length ? { itemIds } : { amount }) }); }}><label>{t.splitName}<input name="splitLabel" required maxLength={80}/></label><label>{t.splitAmount}<input name="splitAmount" type="number" min="1" max={o.total} step="1"/></label><label>{t.splitItems}<select name="itemIds" multiple size={Math.min(4, Math.max(2,o.items.length))}>{o.items.filter(i => i.status !== 'CANCELLED').map(i => <option key={i.id} value={i.id}>{i.name} · {money(i.unitPrice)}</option>)}</select></label><button disabled={busy}>{t.createSplit}</button></form>{o.billSplits.map(s => <small key={s.id}>{s.label}: {money(s.amount)}</small>)}</> }</article>)}{!orders.length && <p className="empty">{t.empty}</p>}</div>}
      {tab === 'kitchen' && <KitchenPanel identity={me} locale={locale} onConnectionChange={me.role === 'KITCHEN' ? setConnected : undefined}/>}
      {tab === 'inventory' && <section><p className="muted">{t.stockHint}</p><div className="tableWrap"><table><thead><tr>{[t.ingredient, t.unit, t.onHand, t.reserved, t.available].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{stock.map(s => <tr key={s.ingredientId}><td>{s.ingredient.name}</td><td>{s.ingredient.unit}</td><td>{s.onHand}</td><td>{s.reserved}</td><td><strong>{s.available}</strong></td></tr>)}</tbody></table></div><h2>{t.adjustment}</h2><form className="adjustForm" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void mutate('/inventory/adjustments', { ingredientId: data.get('ingredientId'), delta: data.get('delta'), reason: data.get('reason') }); }}><label>{t.ingredient}<select name="ingredientId" required>{stock.map(s => <option key={s.ingredientId} value={s.ingredientId}>{s.ingredient.name}</option>)}</select></label><label>{t.delta}<input name="delta" required pattern="-?[0-9]+(\.[0-9]{1,3})?" placeholder="100.000"/></label><label>{t.reason}<input name="reason" required minLength={5} maxLength={300}/></label><button disabled={busy}>{t.save}</button></form><h2>{t.ledger}</h2><div className="tableWrap"><table><thead><tr><th>{t.ingredient}</th><th>{t.onHand}</th><th>{t.reserved}</th></tr></thead><tbody>{movements.slice(0, 30).map(m => <tr key={m.id}><td>{stock.find(s => s.ingredientId === m.ingredientId)?.ingredient.name}</td><td>{m.onHandDelta}</td><td>{m.reservedDelta}</td></tr>)}</tbody></table></div></section>}
      {tab === 'reports' && <section><p className="muted">{t.reportHint}</p><div className="reportTotal"><span>{t.netSales}</span><strong>{money(reports.reduce((s, r) => s + (r.net ?? r._sum.amount), 0))}</strong></div><div className="tableWrap"><table><thead><tr><th>{t.businessDay}</th><th>{t.settledPayments}</th><th>{t.sales}</th><th>{t.refunds}</th><th>{t.netSales}</th></tr></thead><tbody>{reports.map(r => <tr key={r.businessDate}><td>{r.businessDate}</td><td>{r._count.id}</td><td>{money(r._sum.amount)}</td><td>{money(r.refunds ?? 0)}</td><td>{money(r.net ?? r._sum.amount)}</td></tr>)}</tbody></table></div>{!reports.length && <p className="empty">{t.empty}</p>}</section>}
      {tab === 'cash' && can(['OWNER', 'MANAGER', 'CASHIER']) && <CashPanel locale={locale} canApprove={admin} currentUserId={me.userId}/>}
      {tab === 'admin' && admin && <><AdminPanel locale={locale} money={money} onChanged={() => { void load(); setNotice('success'); }} /><QrTablesPanel locale={locale}/><PilotAdminPanel locale={locale}/></>}
    </main></div>;
}




