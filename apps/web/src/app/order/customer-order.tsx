'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
type Option = { id: string; name: string; priceDelta: number; available: boolean };
type Group = { id: string; name: string; minSelections: number; maxSelections: number; options: Option[] };
type Variant = { id: string; name: string; price: number; available: boolean };
type Product = { id: string; name: string; description: string; imageUrl: string | null; price: number; categoryId: string | null; categoryName?: string; available: boolean; variants: Variant[]; modifierGroups: Group[] };
type Menu = { restaurant: { name: string }; table: { name: string }; categories: { id: string; name: string }[]; products: Product[] };
type Selection = { variantId: string; modifierIds: string[]; note: string };
type Line = Selection & { productId: string; key: string; name: string; price: number; quantity: number };
const words = {
  vi: { search: 'Tìm món ăn', all: 'Tất cả', add: 'Thêm vào đơn', cart: 'Đơn của bạn', empty: 'Chọn món bạn yêu thích để bắt đầu.', submit: 'Gửi đơn đến bếp', busy: 'Đang gửi đơn…', note: 'Ghi chú món ăn', custom: 'Tùy chọn món', standard: 'Mặc định', close: 'Đóng', unavailable: 'Tạm hết món', emptyMenu: 'Thực đơn đang được cập nhật.', loading: 'Đang tải thực đơn…', error: 'Không thể tải thực đơn. Hãy kiểm tra QR hoặc thử lại.', sendError: 'Đơn chưa được gửi. Vui lòng thử lại.', restaurant: 'Đặt món tại bàn', table: 'Bàn', total: 'Tạm tính', searchEmpty: 'Không tìm thấy món phù hợp.', min: 'Chọn ít nhất', max: 'Tối đa', required: 'Vui lòng chọn đủ tùy chọn bắt buộc.' },
  en: { search: 'Search menu', all: 'All', add: 'Add to order', cart: 'Your order', empty: 'Choose something you love to get started.', submit: 'Send order to kitchen', busy: 'Sending order…', note: 'Preparation note', custom: 'Customize item', standard: 'Standard', close: 'Close', unavailable: 'Currently unavailable', emptyMenu: 'The menu is being updated.', loading: 'Loading menu…', error: 'Could not load this menu. Check the QR code or try again.', sendError: 'The order was not submitted. Please retry.', restaurant: 'Order at your table', table: 'Table', total: 'Subtotal', searchEmpty: 'No matching dishes found.', min: 'Choose at least', max: 'Maximum', required: 'Please complete the required selections.' },
} as const;
const money = (n: number, locale: 'vi'|'en') => new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(n);

export default function CustomerOrder({ qrToken }: { qrToken: string }) {
  const [locale, setLocale] = useState<'vi'|'en'>('vi'); const t = words[locale];
  const [menu, setMenu] = useState<Menu | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [search, setSearch] = useState(''); const [category, setCategory] = useState(''); const [cart, setCart] = useState<Line[]>([]);
  const [custom, setCustom] = useState<Product | null>(null); const [selection, setSelection] = useState<Selection>({ variantId: '', modifierIds: [], note: '' });
  const [sessionToken, setSessionToken] = useState(''); const lock = useRef(false); const pending = useRef<{ signature: string; key: string } | null>(null);
  const fetchJson = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => { const response = await fetch(`${API}${path}`, { cache: 'no-store', ...init }); const data = await response.json(); if (!response.ok) throw new Error(data.code ?? 'REQUEST_FAILED'); return data as T; }, []);
  useEffect(() => { const saved = localStorage.getItem('omnihub.locale'); if (saved === 'en') setLocale('en'); }, []);
  useEffect(() => { localStorage.setItem('omnihub.locale', locale); document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    let alive = true;
    void fetchJson<Menu>(`/public/qr/${qrToken}/menu`).then(async data => {
      if (!alive) return; setMenu(data);
      const storageKey = `omnihub.tableSession.${qrToken.slice(0, 12)}`; const prior = localStorage.getItem(storageKey);
      if (prior) { try { await fetchJson('/public/table-sessions/me', { headers: { Authorization: `Bearer ${prior}` } }); if (alive) setSessionToken(prior); return; } catch { localStorage.removeItem(storageKey); } }
      const session = await fetchJson<{ token: string }>(`/public/qr/${qrToken}/session`, { method: 'POST' });
      if (alive) { localStorage.setItem(storageKey, session.token); setSessionToken(session.token); }
    }).catch(() => { if (alive) setError(t.error); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [qrToken, fetchJson, t.error]);
  const filtered = useMemo(() => (menu?.products ?? []).filter(p => (!category || p.categoryId === category) && (!search || `${p.name} ${p.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))), [menu, category, search]);
  const customPrice = (product: Product, selected: Selection) => (product.variants.find(v => v.id === selected.variantId)?.price ?? product.price) + product.modifierGroups.flatMap(g => g.options).filter(o => selected.modifierIds.includes(o.id)).reduce((n, o) => n + o.priceDelta, 0);
  const addToCart = (product: Product, selected: Selection) => {
    const variant = product.variants.find(v => v.id === selected.variantId); const modifiers = product.modifierGroups.flatMap(g => g.options.filter(o => selected.modifierIds.includes(o.id)));
    const names = [product.name, variant?.name, ...modifiers.map(o => o.name)].filter(Boolean); const lineKey = `${product.id}/${variant?.id ?? ''}/${[...selected.modifierIds].sort().join(',')}/${selected.note.trim()}`;
    setCart(lines => { const existing = lines.find(l => l.key === lineKey); return existing ? lines.map(l => l.key === lineKey ? { ...l, quantity: l.quantity + 1 } : l) : [...lines, { ...selected, productId: product.id, key: lineKey, name: names.join(' · '), price: customPrice(product, selected), quantity: 1 }]; }); setCustom(null);
  };
  const startCustom = (product: Product) => { setSelection({ variantId: product.variants.find(v => v.available)?.id ?? '', modifierIds: [], note: '' }); setCustom(product); };
  const submitOrder = async () => {
    if (!sessionToken || !cart.length || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    const lines = cart.map(l => ({ productId: l.productId, quantity: l.quantity, ...(l.variantId ? { variantId: l.variantId } : {}), ...(l.modifierIds.length ? { modifierIds: l.modifierIds } : {}), ...(l.note.trim() ? { note: l.note.trim() } : {}) }));
    const signature = JSON.stringify(lines); if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    try {
      const accepted = await fetchJson<{ id: string; trackingToken: string }>('/public/table-sessions/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current.key, Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ lines }) });
      pending.current = null; window.location.assign(`/order/track/${accepted.trackingToken}`);
    } catch (e) { setError(e instanceof Error && e.message !== 'FAILED' ? t.sendError : t.sendError); }
    finally { lock.current = false; setBusy(false); }
  };
  if (loading) return <main className="customerPage"><p role="status">{t.loading}</p></main>;
  if (!menu) return <main className="customerPage"><p role="alert">{error || t.error}</p></main>;
  return <main className="customerPage"><header className="customerHeader"><div><span className="customerMark">OH</span><div><p>{t.restaurant}</p><h1>{menu.restaurant.name}</h1><span>{t.table} · {menu.table.name}</span></div></div><label className="customerLanguage"><span>{locale === 'vi' ? 'Ngôn ngữ' : 'Language'}</span><select aria-label="Language" value={locale} onChange={e => setLocale(e.target.value as 'vi'|'en')}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label></header>
    <section className="customerIntro"><p className="customerKicker">OMNIHUB · MENU</p><h2>{locale === 'vi' ? 'Món ngon, vừa lên bếp.' : 'Good food, made fresh.'}</h2><p>{locale === 'vi' ? 'Chọn món và gửi trực tiếp đến bếp.' : 'Choose your dishes and send them straight to the kitchen.'}</p></section>
    <div className="customerSearch"><input aria-label={t.search} placeholder={t.search} value={search} onChange={e => setSearch(e.target.value)}/><span>⌕</span></div>
    <nav className="customerCategories" aria-label={locale === 'vi' ? 'Danh mục món' : 'Menu categories'}><button className={!category ? 'selected' : ''} onClick={() => setCategory('')}>{t.all}</button>{menu.categories.map(c => <button key={c.id} className={category === c.id ? 'selected' : ''} onClick={() => setCategory(c.id)}>{c.name}</button>)}</nav>
    <div className="customerLayout"><section className="customerMenu" aria-label={locale === 'vi' ? 'Thực đơn' : 'Menu'}>{filtered.map(product => <article className={`customerDish ${!product.available ? 'dishUnavailable' : ''}`} key={product.id}><div className="dishImage">{product.imageUrl ? <img src={product.imageUrl} alt=""/> : <span aria-hidden="true">✦</span>}{!product.available && <small>{t.unavailable}</small>}</div><div className="dishInfo"><p className="dishCategory">{product.categoryName ?? menu.restaurant.name}</p><h3>{product.name}</h3>{product.description && <p className="dishDescription">{product.description}</p>}<div className="dishFoot"><strong>{money(product.price, locale)}</strong><button disabled={!product.available} aria-label={`${t.add} ${product.name}`} onClick={() => startCustom(product)}>+</button></div></div></article>)}{!filtered.length && <p className="customerEmpty">{search ? t.searchEmpty : t.emptyMenu}</p>}</section>
      <aside className="customerCart"><h2>{t.cart}<span>{cart.reduce((n, l) => n + l.quantity, 0)}</span></h2>{cart.length === 0 && <p className="customerEmpty">{t.empty}</p>}{cart.map(line => <div className="customerCartLine" key={line.key}><div><strong>{line.name}</strong><small>{money(line.price, locale)}</small>{line.note && <small>{line.note}</small>}</div><div className="customerQty"><button aria-label="−" onClick={() => setCart(rows => rows.map(r => r.key === line.key ? { ...r, quantity: r.quantity - 1 } : r).filter(r => r.quantity > 0))}>−</button><span>{line.quantity}</span><button aria-label="+" onClick={() => setCart(rows => rows.map(r => r.key === line.key ? { ...r, quantity: r.quantity + 1 } : r))}>+</button></div></div>)}<div className="customerTotal"><span>{t.total}</span><strong>{money(cart.reduce((n, l) => n + l.price * l.quantity, 0), locale)}</strong></div><button className="customerSubmit" disabled={!cart.length || busy || !sessionToken} onClick={() => void submitOrder()}>{busy ? t.busy : t.submit}</button>{error && <p className="customerError" role="alert">{error}</p>}</aside></div>
    {custom && <div className="customerModalBackdrop"><section className="customerModal" role="dialog" aria-modal="true" aria-labelledby="custom-title"><button className="customerClose" onClick={() => setCustom(null)} aria-label={t.close}>×</button><p className="customerKicker">{t.custom}</p><h2 id="custom-title">{custom.name}</h2><strong>{money(customPrice(custom, selection), locale)}</strong>{custom.variants.length > 0 && <fieldset><legend>{locale === 'vi' ? 'Kích cỡ' : 'Size'}</legend>{custom.variants.map(v => <label className="customerChoice" key={v.id}><input type="radio" name="variant" disabled={!v.available} checked={selection.variantId === v.id} onChange={() => setSelection(s => ({ ...s, variantId: v.id }))}/><span>{v.name}</span><span>{money(v.price, locale)}</span></label>)}</fieldset>}{custom.modifierGroups.map(group => <fieldset key={group.id}><legend>{group.name} {group.minSelections > 0 ? `· ${t.min} ${group.minSelections}` : ''}</legend>{group.options.map(option => { const checked = selection.modifierIds.includes(option.id); const count = group.options.filter(o => selection.modifierIds.includes(o.id)).length; return <label className="customerChoice" key={option.id}><input type="checkbox" disabled={!option.available || (!checked && count >= group.maxSelections)} checked={checked} onChange={() => setSelection(s => ({ ...s, modifierIds: checked ? s.modifierIds.filter(id => id !== option.id) : [...s.modifierIds, option.id] }))}/><span>{option.name}</span><span>+{money(option.priceDelta, locale)}</span></label>; })}</fieldset>)}<label className="customerNote">{t.note}<textarea maxLength={250} value={selection.note} onChange={e => setSelection(s => ({ ...s, note: e.target.value }))}/></label><button className="customerSubmit" onClick={() => { const invalid = custom.modifierGroups.some(g => g.options.filter(o => selection.modifierIds.includes(o.id)).length < g.minSelections); if (invalid) { setError(t.required); return; } setError(''); addToCart(custom, selection); }}>{t.add}</button></section></div>}
  </main>;
}
