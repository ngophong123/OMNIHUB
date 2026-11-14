'use client';

import { FormEvent, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export default function InvitationAcceptance({ token }: { token: string }) {
  const [locale, setLocale] = useState<'vi' | 'en'>('vi'); const [error, setError] = useState(''); const [accepted, setAccepted] = useState(false); const [busy, setBusy] = useState(false);
  const t = locale === 'vi' ? { language: 'Ngôn ngữ', title: 'Tham gia cửa hàng', hint: 'Tạo mật khẩu từ 12 ký tự. Nếu email đã có tài khoản OMNIHUB, hãy nhập mật khẩu hiện tại để xác nhận.', password: 'Mật khẩu', accept: 'Xác nhận lời mời', done: 'Đã tham gia. Đăng nhập bằng email và cửa hàng được quản lý gửi cho bạn.', failed: 'Lời mời không hợp lệ, đã hết hạn hoặc mật khẩu hiện tại chưa đúng.', login: 'Đến đăng nhập' } : { language: 'Language', title: 'Join this store', hint: 'Choose a password with at least 12 characters. If this email already has an OMNIHUB account, enter its current password to confirm.', password: 'Password', accept: 'Accept invitation', done: 'You have joined. Sign in with your email and the store details from your manager.', failed: 'The invitation is invalid, expired, or the current password is incorrect.', login: 'Go to sign in' };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const element = event.currentTarget; setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/public/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: new FormData(element).get('password') }) });
      if (!response.ok) { setError(t.failed); return; }
      setAccepted(true); element.reset();
    } catch { setError(t.failed); } finally { setBusy(false); }
  };
  return <main className="login invitePage"><section className="loginBrand"><div className="logo">O<span>H</span></div><p className="eyebrow">OMNIHUB</p><h1>{t.title}</h1></section><section className="loginForm"><label className="language"><span>{t.language}</span><select aria-label={t.language} value={locale} onChange={e => setLocale(e.target.value as 'vi' | 'en')}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label><h2>{t.title}</h2><p>{t.hint}</p>{accepted ? <div role="status"><p>{t.done}</p><a className="secondary" href="/">{t.login}</a></div> : <form onSubmit={submit}><label>{t.password}<input type="password" name="password" required minLength={12} maxLength={128} autoComplete="new-password"/></label><button disabled={busy}>{t.accept}</button></form>}{error && <p className="error" role="alert">{error}</p>}</section></main>;
}
