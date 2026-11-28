import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';

const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3000';
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const STORE_ID = '22222222-2222-4222-8222-222222222222';
const api = (path: string) => `${API_BASE}${path}`;

async function submitLogin(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = page.waitForResponse(r => r.url().endsWith('/auth/login') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    const response = await sent;
    if (response.status() !== 429) return;
    const seconds = Number(response.headers()['retry-after']);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('INVALID_LOGIN_RATE_LIMIT_RESET');
    await page.waitForTimeout(seconds * 1000 + 300);
  }
  throw new Error('LOGIN_RATE_LIMIT_DID_NOT_RESET');
}

async function loginAs(page: Page, email: string) {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill(STORE_ID);
  await submitLogin(page);
}

test('hardening UI: web security headers, closable QR print modal with X-QR-Token, and safe admin direct-switch editing', async ({ page }) => {
  const homeResponse = await page.goto('/');
  expect(homeResponse?.status()).toBe(200);
  const headers = homeResponse?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toContain('camera=()');

  await loginAs(page, 'owner@local.omnihub.test');
  await page.getByRole('button', { name: /Quản trị/ }).click();

  // FE-01 & SEC-05: QR print modal uses X-QR-Token header (no query secret) and can be closed by button & Escape
  let qrRequestUrl = '';
  let qrHeaderToken = '';
  page.on('request', req => {
    if (req.url().includes('/admin/tables/qr-code')) {
      qrRequestUrl = req.url();
      qrHeaderToken = req.headers()['x-qr-token'] ?? '';
    }
  });

  const tableName = `Hardening QR ${Date.now()}`;
  await page.getByLabel('Tên bàn', { exact: true }).fill(tableName);
  await page.getByRole('button', { name: 'Tạo bàn', exact: true }).click();
  const qrDialog = page.getByRole('dialog');
  await expect(qrDialog).toBeVisible();
  expect(qrRequestUrl).not.toContain('token=');
  expect(qrHeaderToken).toMatch(/^[a-f0-9]{64}$/);

  const closeBtn = qrDialog.getByRole('button', { name: 'Đóng', exact: true });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  await expect(qrDialog).toHaveCount(0);

  // Reopen via regenerate and verify Escape key closes modal cleanly
  page.once('dialog', d => void d.accept());
  await page.locator('.qrTableCard').filter({ hasText: tableName }).getByRole('button', { name: 'Tạo lại QR', exact: true }).click();
  await expect(qrDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(qrDialog).toHaveCount(0);

  // FE-02: Switching directly between two edited categories must update form values and never overwrite the wrong entity
  const suffix = Date.now().toString();
  const catA = `DirectSwitch A ${suffix}`;
  const catB = `DirectSwitch B ${suffix}`;
  const catBUpdated = `DirectSwitch B Edited ${suffix}`;

  await page.getByRole('button', { name: 'Danh mục', exact: true }).click();
  for (const name of [catA, catB]) {
    await page.getByRole('button', { name: 'Tạo mới', exact: true }).click();
    await page.getByLabel('Tên', { exact: true }).fill(name);
    const created = page.waitForResponse(r => r.url().endsWith('/admin/categories') && r.request().method() === 'POST');
    await page.locator('.adminForm button').first().click();
    expect((await created).status()).toBe(201);
  }
  await page.getByPlaceholder('Tìm danh mục').fill(`DirectSwitch`);
  const rowA = page.locator('.adminRow').filter({ hasText: catA });
  const rowB = page.locator('.adminRow').filter({ hasText: catB });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await rowA.getByRole('button', { name: 'Sửa', exact: true }).click();
  await expect(page.locator('.adminForm input[name="name"]')).toHaveValue(catA);

  // Switch directly to Cat B WITHOUT closing the Cat A form
  await rowB.getByRole('button', { name: 'Sửa', exact: true }).click();
  await expect(page.locator('.adminForm input[name="name"]')).toHaveValue(catB);
  await page.locator('.adminForm input[name="name"]').fill(catBUpdated);
  const updated = page.waitForResponse(r => /\/admin\/categories\/[^/]+$/.test(r.url()) && r.request().method() === 'PUT');
  await page.locator('.adminForm button').first().click();
  expect((await updated).status()).toBe(200);

  await expect(page.locator('.adminRow').filter({ hasText: catA })).toBeVisible();
  await expect(page.locator('.adminRow').filter({ hasText: catBUpdated })).toBeVisible();
});

test('hardening UI: partial-payment refund approval with cashier shift selector and refund rejection', async ({ browser }) => {
  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();

  // Ensure owner has NO open shift, while cashier opens a dedicated register shift
  await loginAs(ownerPage, 'owner@local.omnihub.test');
  const existingShifts = await (await ownerPage.request.get(api('/cash/shifts'))).json() as {
    id: string; status: string; version: number; openingAmount: number;
    payments: { amount: number }[]; movements: { kind: string; amount: number }[];
  }[];
  for (const s of existingShifts.filter(row => row.status === 'OPEN')) {
    const movSum = s.movements.reduce((acc, m) => acc + (['CASH_IN', 'CORRECTION_IN'].includes(m.kind) ? m.amount : -m.amount), 0);
    const expected = s.openingAmount + s.payments.reduce((acc, p) => acc + p.amount, 0) + movSum;
    await ownerPage.request.post(api(`/cash/shifts/${s.id}/close`), {
      headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
      data: { expectedVersion: s.version, countedAmount: expected },
    });
  }

  const registerName = `Hardening Reg ${Date.now()}`;
  const regRes = await ownerPage.request.post(api('/cash/registers'), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { name: registerName },
  });
  expect(regRes.status()).toBe(201);
  const reg = await regRes.json() as { id: string };

  // Cashier logs in, opens shift, creates an order, and takes a PARTIAL cash payment (15,000 of 30,000)
  await loginAs(cashierPage, 'cashier@local.omnihub.test');
  // Role-gated nav: cashier should NOT see Kitchen tab
  await expect(cashierPage.getByRole('button', { name: /Bếp/ })).toHaveCount(0);

  const openShiftRes = await cashierPage.request.post(api('/cash/shifts'), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { registerId: reg.id, openingAmount: 20_000 },
  });
  expect(openShiftRes.status()).toBe(201);
  const cashierShift = await openShiftRes.json() as { id: string };

  const catalog = await (await cashierPage.request.get(api('/catalog'))).json() as { id: string; name: string; price: number }[];
  const coffee = catalog.find(p => p.name === 'Cà phê đen') ?? catalog[0]!;
  const created = await (await cashierPage.request.post(api('/orders'), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { lines: [{ productId: coffee.id, quantity: 1 }] },
  })).json() as { id: string };

  // Owner advances kitchen states (START -> READY -> HANDOFF)
  for (const action of ['START', 'READY', 'HANDOFF'] as const) {
    const orders = await (await ownerPage.request.get(api('/orders'))).json() as { id: string; version: number; items: { id: string }[] }[];
    const row = orders.find(o => o.id === created.id)!;
    const step = await ownerPage.request.post(api(`/items/${row.items[0]!.id}/commands`), {
      headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
      data: { action, expectedVersion: row.version },
    });
    expect(step.status()).toBe(201);
  }

  // Cashier takes partial payment (15,000) and requests two refunds (2,000 + 3,000)
  const payRes = await cashierPage.request.post(api(`/orders/${created.id}/payments`), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { method: 'CASH', amount: 15_000, tendered: 15_000 },
  });
  expect(payRes.status()).toBe(201);
  const payment = await payRes.json() as { id: string };

  const r1 = await cashierPage.request.post(api(`/payments/${payment.id}/refunds`), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { amount: 2_000, reason: 'Approve partial refund UI test' },
  });
  expect(r1.status()).toBe(201);
  const r2 = await cashierPage.request.post(api(`/payments/${payment.id}/refunds`), {
    headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() },
    data: { amount: 3_000, reason: 'Reject partial refund UI test' },
  });
  expect(r2.status()).toBe(201);

  // Owner (with NO own shift) navigates to Orders, selects cashier's open shift, approves r1, and rejects r2
  await ownerPage.getByRole('button', { name: /Đơn hàng/ }).click();
  await ownerPage.getByRole('button', { name: 'Làm mới', exact: true }).click();
  const card = ownerPage.getByRole('article').filter({ hasText: `#${created.id.slice(0, 8)}` });
  await expect(card).toBeVisible();

  const refundRow1 = card.locator('.orderLine').filter({ hasText: 'Approve partial refund UI test' });
  await refundRow1.locator('select[name="shiftId"]').selectOption(cashierShift.id);
  const approveRes = ownerPage.waitForResponse(r => /\/refunds\/[^/]+\/decision$/.test(r.url()));
  await refundRow1.getByRole('button', { name: 'Duyệt hoàn tiền', exact: true }).click();
  expect((await approveRes).status()).toBe(201);
  await expect(card.getByText('Đã hoàn một phần', { exact: true })).toBeVisible();

  const refundRow2 = card.locator('.orderLine').filter({ hasText: 'Reject partial refund UI test' });
  const rejectRes = ownerPage.waitForResponse(r => /\/refunds\/[^/]+\/decision$/.test(r.url()));
  await refundRow2.getByRole('button', { name: 'Từ chối hoàn tiền', exact: true }).click();
  expect((await rejectRes).status()).toBe(201);
  await expect(refundRow2).toContainText('Từ chối');

  await cashierContext.close();
  await ownerContext.close();
});
