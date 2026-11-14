import 'dotenv/config';
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';

const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3000';
const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const api = (path: string) => `${API_BASE}${path}`;
const artifact = (name: string) => `${process.env.E2E_OUTPUT_DIR ?? 'test-results'}/${name}`;

async function submitLogin(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    const response = await sent;
    if (response.status() !== 429) return;
    // The production limiter remains at ten attempts/minute. Browser acceptance
    // waits for its real Redis reset instead of changing that security control.
    const seconds = Number(response.headers()['retry-after']);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('INVALID_LOGIN_RATE_LIMIT_RESET');
    await page.waitForTimeout(seconds * 1000 + 300);
  }
  throw new Error('LOGIN_RATE_LIMIT_DID_NOT_RESET');
}

async function apiLoginWithRateLimitRetry(request: APIRequestContext, data: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post(api('/auth/login'), { headers: { Origin: WEB_ORIGIN }, data });
    if (response.status() !== 429) return response;
    const seconds = Number(response.headers()['retry-after']);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('INVALID_LOGIN_RATE_LIMIT_RESET');
    await new Promise(resolve => setTimeout(resolve, seconds * 1000 + 300));
  }
  throw new Error('LOGIN_RATE_LIMIT_DID_NOT_RESET');
}

function observeSocket(page: Page) {
  const frames: string[] = [];
  let closed = 0;
  page.on('websocket', socket => {
    socket.on('framereceived', frame => frames.push(frame.payload.toString()));
    socket.on('close', () => { closed++; });
  });
  return {
    frames,
    closed: () => closed,
    received: (orderId: string, type: string) => frames.some(frame => {
      if (!frame.startsWith('42')) return false;
      try { const [name, event] = JSON.parse(frame.slice(2)) as [string, { aggregateId: string; type: string }]; return name === 'operational.event' && event.aggregateId === orderId && event.type === type; }
      catch { return false; }
    }),
  };
}

async function kitchenSocketAuthorized(page: Page, deviceId?: string) {
  return page.evaluate(({ apiBase, deviceId }) => new Promise<boolean>((resolve, reject) => {
    const socket = new WebSocket(`${apiBase.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
    const timeout = window.setTimeout(() => { socket.close(); reject(new Error('Socket handshake timed out')); }, 10_000);
    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (data.startsWith('0')) socket.send(`40${JSON.stringify(deviceId ? { deviceId } : {})}`);
      if (data.startsWith('44') || data.startsWith('40')) {
        window.clearTimeout(timeout); socket.close(); resolve(data.startsWith('40'));
      }
    };
    socket.onerror = () => { window.clearTimeout(timeout); socket.close(); reject(new Error('Socket transport failed')); };
  }), { apiBase: API_BASE, deviceId });
}

test('desktop: POS -> kitchen -> cash -> report, English switch and mobile layout', async ({ page }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
  await submitLogin(page);
  await expect(page.getByRole('heading', { name: 'Bán hàng', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Ca & đối soát/ }).click();
  const priorShifts = await (await page.request.get(api('/cash/shifts'))).json() as { id: string; status: string; version: number; openingAmount: number; payments: { amount: number }[]; movements: { kind: string; amount: number; reason: string }[] }[];
  for (const shift of priorShifts.filter(s => s.status === 'OPEN' && s.movements.some(m => m.reason === 'Float top up') && s.movements.some(m => m.reason === 'Delivery fee'))) {
    const movementSum = shift.movements.reduce((sum, m) => sum + (['CASH_IN', 'CORRECTION_IN'].includes(m.kind) ? m.amount : -m.amount), 0);
    const expected = shift.openingAmount + shift.payments.reduce((sum, payment) => sum + payment.amount, 0) + movementSum;
    const closed = await page.request.post(api(`/cash/shifts/${shift.id}/close`), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { expectedVersion: shift.version, countedAmount: expected } });
    expect(closed.ok()).toBe(true);
  }
  const registerName = `E2E workflow ${Date.now()}`;
  await page.getByLabel('Thêm quầy').fill(registerName);
  await page.getByRole('button', { name: 'Tạo quầy', exact: true }).click();
  await page.locator('select[name="registerId"]').selectOption({ label: registerName });
  await page.getByLabel('Tiền đầu ca (VND)').fill('0');
  await page.getByRole('button', { name: 'Mở ca', exact: true }).click();
  await expect(page.getByText('Đang mở / chờ duyệt')).toBeVisible();
  await page.getByRole('button', { name: /Bán hàng/ }).click();
  await page.getByRole('button', { name: /Cà phê đen/ }).click();
  const acceptedResponse = page.waitForResponse(r => r.url().endsWith('/orders') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Nhận đơn & giữ nguyên liệu' }).click();
  const accepted = await (await acceptedResponse).json() as { id: string };
  const card = page.getByRole('article').filter({ hasText: `#${accepted.id.slice(0, 8)}` });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Bắt đầu', exact: true }).click();
  await card.getByRole('button', { name: 'Đã làm xong', exact: true }).click();
  await card.getByRole('button', { name: 'Giao món', exact: true }).click();
  await card.getByLabel('Tên người thanh toán').fill('Payer A');
  await card.getByLabel('Chia theo số tiền (để trống nếu chọn món)').fill('15000');
  const splitResponse = page.waitForResponse(r => r.url().endsWith(`/orders/${accepted.id}/splits`));
  await card.getByRole('button', { name: 'Tạo phần hóa đơn', exact: true }).click();
  const split = await (await splitResponse).json() as { id: string };
  await expect(card.locator('small').filter({ hasText: 'Payer A:' })).toBeVisible();
  await card.getByLabel('Số tiền thanh toán').fill('15000');
  await card.getByLabel('Tiền khách đưa').fill('15000');
  await card.getByLabel('Phân bổ vào phần hóa đơn').selectOption(split.id);
  const paymentResponse = page.waitForResponse(r => r.url().endsWith(`/orders/${accepted.id}/payments`));
  await card.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
  const paymentResult = await paymentResponse;
  expect(paymentResult.status(), await paymentResult.text()).toBe(201);
  await expect(card.getByText('Thanh toán một phần', { exact: true })).toBeVisible();
  await card.getByLabel('Số tiền thanh toán').fill('15000');
  await card.getByLabel('Tiền khách đưa').fill('15000');
  await card.getByLabel('Phân bổ vào phần hóa đơn').selectOption('');
  const secondPayment = page.waitForResponse(r => r.url().endsWith(`/orders/${accepted.id}/payments`));
  await card.getByRole('button', { name: 'Ghi nhận thanh toán', exact: true }).click();
  expect((await secondPayment).status()).toBe(201);
  await expect(card.getByText('Hoàn tất', { exact: true })).toBeVisible();
  await card.getByLabel('Khoản thanh toán gốc').selectOption({ index: 0 });
  await card.getByLabel('Số tiền hoàn (VND)').fill('1000');
  await card.getByLabel('Món cần hoàn (không chọn để hoàn khoản thanh toán)').selectOption({ index: 1 });
  await card.getByLabel('Lý do hoàn tiền').fill('Khách báo thiếu món');
  const refundResponse = page.waitForResponse(r => /\/payments\/[^/]+\/refunds$/.test(r.url()));
  await card.getByRole('button', { name: 'Gửi yêu cầu hoàn tiền', exact: true }).click();
  expect((await refundResponse).status()).toBe(201);
  await card.getByRole('button', { name: 'Duyệt hoàn tiền', exact: true }).click();
  await expect(card.getByText('Đã hoàn một phần', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Bán hàng/ }).click();
  await page.getByRole('button', { name: /Cà phê đen/ }).click();
  const cancelOrderCreated = page.waitForResponse(r => r.url().endsWith('/orders') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Nhận đơn & giữ nguyên liệu' }).click();
  const cancelOrderId = (await (await cancelOrderCreated).json() as { id: string }).id;
  const cancelCard = page.getByRole('article').filter({ hasText: `#${cancelOrderId.slice(0, 8)}` });
  const cancelDialog = (dialog: import('@playwright/test').Dialog) => dialog.type() === 'prompt' ? dialog.accept('Khách yêu cầu hủy đơn') : dialog.accept();
  page.on('dialog', cancelDialog);
  await cancelCard.getByRole('button', { name: 'Hủy đơn hàng', exact: true }).click();
  page.off('dialog', cancelDialog);
  await expect(cancelCard.getByText('Đã hủy', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Ca & đối soát/ }).click();
  const activeShift = page.locator('.cashPanel .orderCard').first();
  await activeShift.locator('input[name="countedAmount"]').fill('29000');
  await activeShift.getByRole('button', { name: 'Chốt ca', exact: true }).click();
  await expect(page.locator('.cashPanel').getByText('Lịch sử ca')).toBeVisible();
  await page.getByRole('button', { name: /Báo cáo/ }).click();
  await expect(page.getByRole('table')).toContainText('Ngày kinh doanh');
  const reportResponse = await page.request.get(api('/reports/daily'));
  expect(reportResponse.ok()).toBe(true);
  const rows = await reportResponse.json() as { _sum: { amount: number } }[];
  expect(rows.reduce((sum, row) => sum + row._sum.amount, 0)).toBeGreaterThanOrEqual(30000);
  await page.getByLabel('Ngôn ngữ').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await page.screenshot({ path: artifact('desktop-report.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Point of sale/ }).click();
  await expect(page.getByRole('heading', { name: 'Menu', exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: artifact('mobile-pos.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: artifact('tablet-login.png'), fullPage: true });
});

test('cash shifts: cash-in/out, matching close, discrepancy approval and responsive history', async ({ page }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
  await submitLogin(page);
  await page.getByRole('button', { name: /Ca & đối soát/ }).click();
  const existingShifts = await (await page.request.get(api('/cash/shifts'))).json() as { id: string; status: string; approvalStatus: string; version: number; register: { name: string }; expectedAmount: number | null; countedAmount: number | null; reason: string | null }[];
  for (const shift of existingShifts.filter(s => s.register.name.startsWith('E2E cash ') && s.status === 'CLOSING' && s.approvalStatus === 'PENDING')) {
    const approved = await page.request.post(api(`/cash/shifts/${shift.id}/approve`), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { expectedVersion: shift.version, reason: 'E2E retry cleanup approved' } });
    expect(approved.ok()).toBe(true);
  }
  const registerName = `E2E cash ${Date.now()}`;
  await page.getByLabel('Thêm quầy').fill(registerName);
  await page.getByRole('button', { name: 'Tạo quầy', exact: true }).click();
  await page.locator('select[name="registerId"]').selectOption({ label: registerName });
  await page.getByLabel('Tiền đầu ca (VND)').fill('10000');
  await page.getByRole('button', { name: 'Mở ca', exact: true }).click();
  let active = page.locator('.cashPanel .orderCard').first();
  await active.locator('select[name="kind"]').selectOption('CASH_IN');
  await active.locator('input[name="amount"]').fill('5000');
  await active.locator('input[name="reason"]').nth(1).fill('Float top up');
  await active.getByRole('button', { name: 'Đã ghi nhận', exact: true }).click();
  active = page.locator('.cashPanel .orderCard').first();
  await active.locator('select[name="kind"]').selectOption('CASH_OUT');
  await active.locator('input[name="amount"]').fill('2000');
  await active.locator('input[name="reason"]').nth(1).fill('Delivery fee');
  await active.getByRole('button', { name: 'Đã ghi nhận', exact: true }).click();
  active = page.locator('.cashPanel .orderCard').first();
  await active.locator('input[name="countedAmount"]').fill('13000');
  await active.getByRole('button', { name: 'Chốt ca', exact: true }).click();
  await expect(page.locator('.cashPanel table')).toContainText(/13[.,]000/);
  await page.getByLabel('Tiền đầu ca (VND)').fill('20000');
  await page.getByRole('button', { name: 'Mở ca', exact: true }).click();
  active = page.locator('.cashPanel .orderCard').first();
  await active.locator('input[name="countedAmount"]').fill('19000');
  await active.locator('input[name="reason"]').first().fill('Cash short by one thousand');
  await active.getByRole('button', { name: 'Chốt ca', exact: true }).click();
  active = page.locator('.cashPanel .orderCard').first();
  await active.getByLabel('Ghi chú quản lý').fill('Manager checked the drawer');
  await expect(active.getByLabel('Ghi chú quản lý')).toHaveValue('Manager checked the drawer');
  const approvalResponse = page.waitForResponse(r => r.url().includes('/cash/shifts/') && r.url().endsWith('/approve'), { timeout: 8000 });
  await active.getByRole('button', { name: 'Quản lý duyệt', exact: true }).click();
  const approvalResult = await approvalResponse;
  expect(approvalResult.status(), await approvalResult.text()).toBe(201);
  await expect(page.locator('.cashPanel table')).toContainText('APPROVED');
  await page.getByLabel('Ngôn ngữ').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Cash shifts', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('realtime: another kitchen device receives a committed order before polling', async ({ browser }) => {
  const kitchenContext = await browser.newContext();
  const kitchen = await kitchenContext.newPage();
  const wire = observeSocket(kitchen);
  const transports: WebSocketRoute[] = [];
  // Forward real server frames unchanged. Closing this transport exercises an
  // actual Socket.IO reconnect; browser offline emulation can leave sockets open.
  await kitchen.routeWebSocket('**/socket.io/**', route => {
    const server = route.connectToServer();
    server.onMessage(frame => { wire.frames.push(frame.toString()); route.send(frame); });
    transports.push(route);
  });
  await kitchen.goto('/');
  await kitchen.getByLabel('Email', { exact: true }).fill('kitchen@local.omnihub.test');
  await kitchen.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD!);
  await kitchen.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
  await submitLogin(kitchen);
  await expect(kitchen.getByRole('heading', { name: 'Bếp', exact: true })).toBeVisible();
  await expect(kitchen.getByText('Đã kết nối', { exact: true })).toBeVisible();
  const cashierContext = await browser.newContext(); const cashier = await cashierContext.newPage();
  const cashierWire = observeSocket(cashier);
  await cashier.goto('/'); await cashier.getByLabel('Email', { exact: true }).fill('cashier@local.omnihub.test'); await cashier.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD!); await cashier.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222'); await submitLogin(cashier);
  for (const reconnect of [false, true]) {
    if (reconnect) {
      const handshakes = wire.frames.filter(frame => frame.startsWith('40')).length;
      await transports.at(-1)!.close({ code: 1012, reason: 'E2E transport interruption' });
      await expect.poll(() => wire.frames.filter(frame => frame.startsWith('40')).length, { timeout: 15000 }).toBeGreaterThan(handshakes);
      await expect(kitchen.getByText('Đã kết nối', { exact: true })).toBeVisible();
    }
    await cashier.getByRole('button', { name: /Bán hàng/ }).click(); await cashier.getByRole('button', { name: /Cà phê đen/ }).click();
    const accepted = cashier.waitForResponse(response => response.url().endsWith('/orders') && response.request().method() === 'POST');
    await cashier.getByRole('button', { name: 'Nhận đơn & giữ nguyên liệu', exact: true }).click();
    const response = await accepted; expect(response.status()).toBe(201); const order = await response.json() as { id: string }; const start = Date.now();
    await expect.poll(() => wire.received(order.id, 'order.accepted'), { timeout: 5000 }).toBe(true);
    const ticket = kitchen.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` }); await expect(ticket).toBeVisible({ timeout: 5000 });
    expect(Date.now() - start).toBeLessThan(5000);
    await ticket.getByRole('button', { name: 'Bắt đầu làm', exact: true }).click();
    await expect.poll(() => wire.received(order.id, 'kitchen.item.started'), { timeout: 5000 }).toBe(true);
    await expect.poll(() => cashierWire.received(order.id, 'kitchen.item.started'), { timeout: 5000 }).toBe(true);
    // The frame assertions above prove push delivery. Rendering also waits for
    // the authoritative HTTP read, which can be slower on the local fixture DB.
    await expect(cashier.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` })).toContainText('Đang làm', { timeout: 10000 });
  }
  expect((await kitchenContext.request.get(api('/reports/daily'))).status()).toBe(403);
  expect((await kitchenContext.request.post(api('/orders'), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { lines: [{ productId: crypto.randomUUID(), quantity: 1 }] } })).status()).toBe(403);
  await kitchen.screenshot({ path: artifact('kitchen-realtime.png'), fullPage: true });
  await kitchenContext.close();
  await cashierContext.close();
});

test('offline kitchen: cached ticket and durable ordered commands reconcile after reconnect', async ({ browser, request }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  const storeId = '22222222-2222-4222-8222-222222222222';
  const kitchenContext = await browser.newContext({ viewport: { width: 820, height: 1180 } }); const kitchen = await kitchenContext.newPage();
  await kitchen.goto('/'); await kitchen.getByLabel('Email', { exact: true }).fill('kitchen@local.omnihub.test');
  await kitchen.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD); await kitchen.getByLabel('Mã cửa hàng', { exact: true }).fill(storeId);
  await submitLogin(kitchen); await expect(kitchen.getByRole('heading', { name: 'Bếp', exact: true })).toBeVisible();
  const ready = await kitchen.evaluate(async () => { await navigator.serviceWorker.ready; return true; }); expect(ready).toBe(true);
  const auth = await apiLoginWithRateLimitRetry(request, { email: 'cashier@local.omnihub.test', password: process.env.DEMO_PASSWORD, storeId }); expect(auth.ok()).toBe(true);
  const products = await (await request.get(api('/catalog'))).json() as { id: string }[];
  const accepted = await request.post(api('/orders'), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { lines: [{ productId: products[0]!.id, quantity: 1 }] } }); expect(accepted.ok()).toBe(true);
  const order = await accepted.json() as { id: string }; const ticket = kitchen.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` }); await kitchen.getByRole('button', { name: 'Đồng bộ lại', exact: true }).click(); await expect(ticket).toBeVisible({ timeout: 8000 });
  await kitchen.reload(); await expect(kitchen.getByRole('heading', { name: 'Bếp', exact: true })).toBeVisible(); await expect.poll(() => kitchen.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true); await expect(kitchen.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` })).toBeVisible();
  await kitchenContext.setOffline(true); await expect(kitchen.getByText('Ngoại tuyến', { exact: true })).toBeVisible();
  const offlineTicket = kitchen.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` });
  await offlineTicket.getByRole('button', { name: 'Bắt đầu làm', exact: true }).click();
  await expect(offlineTicket).toContainText('Đang chế biến'); await expect(offlineTicket).toContainText('Đã lưu trên thiết bị, chờ đồng bộ');
  await offlineTicket.getByRole('button', { name: 'Đã xong', exact: true }).click(); await expect(offlineTicket).toContainText('Đã xong');
  await kitchen.reload(); await expect(kitchen.getByRole('article').filter({ hasText: `#${order.id.slice(0, 8)}` })).toContainText('Đã xong');
  let replayBody: unknown; kitchen.on('request', req => { if (req.url().endsWith('/kitchen/sync') && req.method() === 'POST') replayBody = req.postDataJSON(); });
  await kitchenContext.setOffline(false); await expect(kitchen.getByText('Bếp trực tuyến', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(kitchen.getByText('Đã đồng bộ', { exact: true })).toBeVisible({ timeout: 15000 });
  expect(replayBody).toBeTruthy();
  const replayDeviceId = (replayBody as { commands: { deviceId: string }[] }).commands[0]!.deviceId;
  const replayed = await kitchen.evaluate(async ({ body, apiBase, deviceId }) => { const response = await fetch(`${apiBase}/kitchen/sync`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Kitchen-Device': deviceId }, body: JSON.stringify(body) }); return { status: response.status, result: await response.json() }; }, { body: replayBody, apiBase: API_BASE, deviceId: replayDeviceId });
  expect(replayed.status).toBe(201); expect(replayed.result).toMatchObject({ results: [{ status: 'CONFIRMED' }, { status: 'CONFIRMED' }] });
  const authoritative = await kitchenContext.request.get(api('/orders'), { headers: { 'X-Kitchen-Device': replayDeviceId } }); expect(authoritative.ok()).toBe(true); const serverOrders = await authoritative.json() as { id: string; version: number; items: { status: string }[] }[];
  expect(serverOrders.find(row => row.id === order.id)).toMatchObject({ version: 3, items: [{ status: 'READY' }] });
  await kitchen.setViewportSize({ width: 390, height: 844 }); expect(await kitchen.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await kitchen.setViewportSize({ width: 820, height: 1180 }); expect(await kitchen.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await kitchen.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await kitchenContext.close();
});

test('offline kitchen: a competing server update blocks dependent local commands for review', async ({ browser, request }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  const storeId = '22222222-2222-4222-8222-222222222222'; const context = await browser.newContext(); const page = await context.newPage();
  await page.goto('/'); await page.getByLabel('Email', { exact: true }).fill('kitchen@local.omnihub.test'); await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD); await page.getByLabel('Mã cửa hàng', { exact: true }).fill(storeId); await submitLogin(page);
  await expect(page.getByRole('heading', { name: 'Bếp', exact: true })).toBeVisible();
  const ownerLogin = await apiLoginWithRateLimitRetry(request, { email: 'owner@local.omnihub.test', password: process.env.DEMO_PASSWORD, storeId }); expect(ownerLogin.ok()).toBe(true);
  const products = await (await request.get(api('/catalog'))).json() as { id: string; available?: boolean }[]; const product = products.find(row => row.available) ?? products[0]!;
  const accepted = await request.post(api('/orders'), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { lines: [{ productId: product.id, quantity: 1 }] } }); expect(accepted.ok()).toBe(true); const created = await accepted.json() as { id: string };
  await page.getByRole('button', { name: 'Đồng bộ lại', exact: true }).click(); const ticket = page.getByRole('article').filter({ hasText: `#${created.id.slice(0, 8)}` }); await expect(ticket).toBeVisible();
  const currentOrders = await (await request.get(api('/orders'))).json() as { id: string; version: number; items: { id: string }[] }[]; const order = currentOrders.find(row => row.id === created.id)!; const itemId = order.items[0]!.id;
  await context.setOffline(true); await expect(page.getByText('Ngoại tuyến', { exact: true })).toBeVisible(); await ticket.getByRole('button', { name: 'Bắt đầu làm', exact: true }).click(); await ticket.getByRole('button', { name: 'Đã xong', exact: true }).click(); await expect(ticket).toContainText('Đã xong');
  const remote = await request.post(api(`/items/${itemId}/commands`), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { action: 'START', expectedVersion: order.version } }); expect(remote.status()).toBe(201);
  await context.setOffline(false); await expect(page.getByRole('heading', { name: /Cần xem lại thao tác ngoại tuyến/ })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/PREVIOUS_COMMAND_CONFLICT|STALE_OR_TERMINAL_ORDER/).first()).toBeVisible();
  const authoritative = await (await request.get(api('/orders'))).json() as { id: string; version: number; items: { id: string; status: string }[] }[];
  expect(authoritative.find(row => row.id === created.id)).toMatchObject({ version: order.version + 1, items: [{ id: itemId, status: 'PREPARING' }] });
  await expect(page.getByRole('heading', { name: /Cần xem lại thao tác ngoại tuyến/ })).toContainText('2');
  await context.close();
});

test('HTTP origin enforcement, anonymous access and validation', async ({ request }) => {
  expect((await request.get(api('/orders'))).status()).toBe(401);
  expect((await request.post(api('/orders'), { data: {} })).status()).toBe(403);
  expect((await apiLoginWithRateLimitRetry(request, { email: 'wrong' })).status()).toBe(400);
});

test('owner: manages category, station, ingredient, receipt, recipe, variants and modifiers through admin UI', async ({ page }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  const suffix = Date.now().toString(); const productName = `E2E drink ${suffix}`;
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
  await submitLogin(page);
  await page.getByRole('button', { name: /Quản trị/ }).click();
  await page.getByRole('button', { name: 'Danh mục', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo mới', exact: true }).click();
  await page.getByLabel('Tên', { exact: true }).fill(`E2E drinks ${suffix}`);
  const categoryCreated = page.waitForResponse(r => r.url().endsWith('/admin/categories') && r.request().method() === 'POST');
  await page.locator('.adminForm button').first().click();
  expect((await categoryCreated).status()).toBe(201);
  const categorySearch = page.waitForResponse(r => r.url().includes(`/admin/categories?q=${encodeURIComponent(`E2E drinks ${suffix}`)}`));
  await page.getByPlaceholder('Tìm danh mục').fill(`E2E drinks ${suffix}`);
  const categorySearchResponse = await categorySearch;
  expect(categorySearchResponse.ok(), await categorySearchResponse.text()).toBe(true);
  const categorySearchResult = await categorySearchResponse.json() as { rows: { name: string }[] };
  expect(categorySearchResult.rows.some(row => row.name === `E2E drinks ${suffix}`)).toBe(true);
  await expect(page.locator('.adminRow').filter({ hasText: `E2E drinks ${suffix}` })).toBeVisible();
  await page.getByRole('button', { name: 'Trạm bếp', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo mới', exact: true }).click();
  await page.getByLabel('Tên', { exact: true }).fill(`E2E station ${suffix}`);
  await page.locator('.adminForm button').first().click();
  await expect(page.locator('.adminRow').filter({ hasText: `E2E station ${suffix}` })).toBeVisible();
  await page.getByRole('button', { name: 'Nguyên liệu', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo mới', exact: true }).click();
  await page.getByLabel('Tên', { exact: true }).fill(`E2E coffee ${suffix}`);
  await page.locator('.adminForm button').first().click();
  await expect(page.locator('.adminRow').filter({ hasText: `E2E coffee ${suffix}` })).toBeVisible();
  await page.getByRole('button', { name: 'Nhập kho', exact: true }).click();
  await page.getByLabel('Mã phiếu').fill(`E2E-${suffix}`);
  await page.getByLabel('Nhà cung cấp').fill('Playwright supplier');
  await page.locator('select[name="ingredientId"]').selectOption({ label: `E2E coffee ${suffix} (g)` });
  await page.getByLabel('Số lượng').fill('250');
  const receiptCreated = page.waitForResponse(r => r.url().endsWith('/admin/inventory/receipts') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ghi nhận nhập kho', exact: true }).click();
  expect((await receiptCreated).status()).toBe(201);
  await expect(page.getByRole('status')).toContainText('Đã ghi nhận', { timeout: 10000 });
  await page.getByRole('button', { name: 'Món & công thức', exact: true }).click();
  await page.getByRole('button', { name: 'Tạo mới', exact: true }).click();
  await page.getByLabel('Tên', { exact: true }).fill(productName);
  await page.getByLabel('Mô tả').fill('Recipe and modifier UI check');
  await page.getByLabel('Giá (VND)').fill('32000');
  await page.locator('select[name="categoryId"]').selectOption({ label: `E2E drinks ${suffix}` });
  await page.locator('select[name="stationId"]').selectOption({ label: `E2E station ${suffix}` });
  await page.locator('.recipeLine select').selectOption({ label: `E2E coffee ${suffix} (g)` });
  await page.getByLabel('Số lượng').fill('20');
  const productCreateResponse = page.waitForResponse(r => r.url().endsWith('/admin/products') && r.request().method() === 'POST');
  await page.locator('.productEditor > .adminActions button').first().click();
  const createdProduct = await productCreateResponse; expect(createdProduct.status(), await createdProduct.text()).toBe(201);
  const productSearch = page.waitForResponse(r => r.url().includes(`/admin/products?q=${encodeURIComponent(productName)}`));
  await page.getByPlaceholder('Tìm món').fill(productName);
  const productSearchResponse = await productSearch;
  expect(productSearchResponse.ok(), await productSearchResponse.text()).toBe(true);
  const productSearchResult = await productSearchResponse.json() as { rows: { name: string }[] };
  expect(productSearchResult.rows.some(row => row.name === productName)).toBe(true);
  const row = page.locator('.adminRow').filter({ hasText: productName });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole('button', { name: 'Sửa', exact: true }).click();
  await page.getByPlaceholder('Tên biến thể').fill('Large');
  await page.getByPlaceholder('Giá biến thể').fill('40000');
  await page.getByRole('button', { name: 'Thêm biến thể', exact: true }).click();
  await expect(page.getByText(/Large ·/)).toBeVisible();
  await page.getByPlaceholder('Tên nhóm').fill('Topping');
  await page.getByRole('button', { name: 'Thêm nhóm', exact: true }).click();
  await page.getByPlaceholder('Tên lựa chọn').fill('Extra coffee');
  await page.getByPlaceholder('Giá cộng thêm').fill('5000');
  const optionCreated = page.waitForResponse(r => /\/admin\/modifier-groups\/[^/]+\/options$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Thêm lựa chọn', exact: true }).click();
  expect((await optionCreated).status()).toBe(201);
  await page.getByRole('button', { name: /Bán hàng/ }).click();
  const menuItem = page.locator('.product').filter({ hasText: productName });
  await expect(menuItem).toBeEnabled();
  await menuItem.click();
  await page.getByRole('dialog').locator('select').selectOption({ index: 1 });
  const extraCoffee = page.getByRole('dialog').getByLabel(/Extra coffee/);
  await expect(extraCoffee).toBeVisible({ timeout: 10_000 });
  await extraCoffee.check();
  await page.getByRole('dialog').getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.locator('.cart')).toContainText('45.000');
  const orderResponse = page.waitForResponse(r => r.url().endsWith('/orders') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Nhận đơn & giữ nguyên liệu' }).click();
  const accepted = await (await orderResponse).json() as { id: string };
  expect(accepted.id).toBeTruthy();
  await expect(page.locator('.orderCard').filter({ hasText: productName })).toContainText('45.000');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Quản trị/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: artifact('mobile-admin.png'), fullPage: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('customer QR ordering: manager creates and prints a table QR, guest orders on mobile and tracks the private order', async ({ page }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill('22222222-2222-4222-8222-222222222222');
  await submitLogin(page);
  await page.getByRole('button', { name: /Quản trị/ }).click();
  await expect(page.getByRole('heading', { name: 'Bàn & QR gọi món' })).toBeVisible();
  const qrToggle = page.getByLabel('Bật đặt món QR cho cửa hàng');
  await expect(qrToggle).toBeEnabled();
  if (!(await qrToggle.isChecked())) {
    const configured = page.waitForResponse(response => response.url().endsWith('/admin/tables/config') && response.request().method() === 'PUT');
    await qrToggle.click(); expect((await configured).ok()).toBe(true); await expect(qrToggle).toBeChecked();
  }
  const tableName = `E2E QR ${Date.now()}`;
  await page.getByLabel('Tên bàn', { exact: true }).fill(tableName);
  const tableCreated = page.waitForResponse(r => r.url().endsWith('/admin/tables') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Tạo bàn', exact: true }).click();
  const tableResponse = await tableCreated;
  expect(tableResponse.status(), await tableResponse.text()).toBe(201);
  const created = await tableResponse.json() as { id: string; token: string };
  await expect(page.getByRole('heading', { name: 'Quét để xem thực đơn' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Tải SVG' }).click();
  expect((await download).suggestedFilename()).toContain('omnihub');

  await page.goto(`/order/${created.token}`);
  await expect(page.getByRole('heading', { name: 'Cà phê đen' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.customerHeader')).toContainText(tableName);
  const menu = await (await page.request.get(api(`/public/qr/${created.token}/menu`))).json() as { products: { id: string; name: string; available: boolean }[] };
  const product = menu.products.find(p => p.name === 'Cà phê đen' && p.available) ?? menu.products.find(p => p.available);
  expect(product, 'seed menu needs at least one available recipe-backed product').toBeTruthy();
  await page.getByRole('button', { name: `Thêm vào đơn ${product!.name}`, exact: true }).click();
  if (await page.getByRole('dialog').count()) { await page.getByLabel('Ghi chú món ăn').fill('Ít đá'); await page.getByRole('dialog').getByRole('button', { name: 'Thêm vào đơn' }).click(); }
  await expect(page.getByRole('button', { name: 'Gửi đơn đến bếp' })).toBeEnabled();
  const submitted = page.waitForResponse(r => r.url().endsWith('/public/table-sessions/orders') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Gửi đơn đến bếp' }).click();
  const orderResponse = await submitted;
  expect(orderResponse.status()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Theo dõi đơn hàng' })).toBeVisible();
  await expect(page.locator('.trackStatus').getByText('Đã nhận đơn', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const statusUrl = page.url();
  const secret = statusUrl.split('/').at(-1)!;
  const tracking = await page.request.get(api(`/public/order-status/${secret}`));
  expect(tracking.ok()).toBe(true);
  expect(await tracking.json()).toMatchObject({ status: 'ACCEPTED', items: [{ name: product!.name }] });
  const invalidTracking = await page.request.get(api(`/public/order-status/${'0'.repeat(64)}`));
  expect(invalidTracking.status()).toBe(404);
});

test('pilot admin: invite kitchen employee, assign a device station and block its registration after revocation', async ({ page, browser }) => {
  test.setTimeout(process.env.E2E_WEB_ORIGIN ? 180_000 : 90_000);
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  const storeId = '22222222-2222-4222-8222-222222222222'; const email = `pilot-${crypto.randomUUID()}@local.omnihub.test`; const password = `Pilot-${crypto.randomUUID()}-Aa9!`;
  await page.goto('/'); await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test'); await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD); await page.getByLabel('Mã cửa hàng', { exact: true }).fill(storeId); await submitLogin(page);
  await expect(page.getByRole('heading', { name: 'Bán hàng', exact: true })).toBeVisible(); await page.getByRole('button', { name: /Quản trị/ }).click();
  await expect(page.getByRole('heading', { name: 'Sẵn sàng vận hành thử', exact: true })).toBeVisible();
  await page.getByLabel('Email nhân viên').fill(email); await page.getByLabel('Vai trò').selectOption('KITCHEN'); await page.getByRole('button', { name: 'Tạo lời mời', exact: true }).click();
  const invitationUrl = (await page.locator('.inviteLink small').textContent())?.trim(); expect(invitationUrl).toContain('/invite/');
  const token = new URL(invitationUrl!).pathname.split('/').at(-1)!;
  const accepted = await page.request.post(api(`/public/invitations/${token}/accept`), { headers: { Origin: WEB_ORIGIN }, data: { password } }); expect(accepted.ok()).toBe(true);
  const catalog = await (await page.request.get(api('/catalog'))).json() as { id: string; available: boolean }[]; const product = catalog.find(row => row.available); expect(product).toBeTruthy();
  const created = await page.request.post(api('/orders'), { headers: { Origin: WEB_ORIGIN, 'Idempotency-Key': crypto.randomUUID() }, data: { lines: [{ productId: product!.id, quantity: 1 }] } }); expect(created.ok()).toBe(true);
  const createdOrder = await created.json() as { id: string }; const orderRows = await (await page.request.get(api('/orders'))).json() as { id: string; version: number; items: { id: string }[] }[]; const createdOrderRow = orderRows.find(row => row.id === createdOrder.id); expect(createdOrderRow?.items[0]).toBeTruthy();

  const kitchenContext = await browser.newContext(); const kitchenPage = await kitchenContext.newPage(); let deviceId = '';
  const kitchenWire = observeSocket(kitchenPage);
  kitchenPage.on('request', req => { if (req.url().endsWith('/kitchen/devices/register') && req.method() === 'POST') deviceId = (req.postDataJSON() as { deviceId: string }).deviceId; });
  await kitchenPage.goto('/'); await kitchenPage.getByLabel('Email', { exact: true }).fill(email); await kitchenPage.getByLabel('Mật khẩu', { exact: true }).fill(password); await kitchenPage.getByLabel('Mã cửa hàng', { exact: true }).fill(storeId); await submitLogin(kitchenPage);
  await expect(kitchenPage.getByRole('heading', { name: 'Bếp', exact: true })).toBeVisible(); await expect.poll(() => deviceId).not.toBe('');
  await expect(kitchenPage.getByText('Đã kết nối', { exact: true })).toBeVisible();
  expect(await kitchenSocketAuthorized(kitchenPage)).toBe(false);

  await page.locator('.pilotAdmin').getByRole('button', { name: 'Làm mới', exact: true }).click();
  const deviceRow = page.locator('.pilotDevice').filter({ hasText: email }); await expect(deviceRow).toBeVisible();
  const assignment = page.getByLabel(`Trạm bếp ${email}`); await expect.poll(() => assignment.locator('option').count()).toBeGreaterThan(1);
  const assigned = page.waitForResponse(response => response.url().endsWith(`/admin/kitchen/devices/${deviceId}/assignment`) && response.request().method() === 'PUT');
  await assignment.selectOption({ index: 1 }); expect((await assigned).ok()).toBe(true);
  await expect.poll(() => assignment.inputValue()).not.toBe('');
  await expect.poll(() => kitchenWire.frames.filter(frame => frame.startsWith('40')).length, { timeout: 35000 }).toBeGreaterThan(1);
  const closedBeforeRevocation = kitchenWire.closed();
  page.once('dialog', dialog => dialog.accept()); await deviceRow.getByRole('button', { name: 'Thu hồi', exact: true }).click(); await expect(deviceRow).toContainText('Đã thu hồi');
  const kitchenMe = await (await kitchenContext.request.get(api('/auth/me'))).json() as { userId: string; tenantId: string; storeId: string };
  const revokedSync = await kitchenContext.request.post(api('/kitchen/sync'), { headers: { Origin: WEB_ORIGIN, 'X-Kitchen-Device': deviceId }, data: { commands: [{ commandId: crypto.randomUUID(), tenantId: kitchenMe.tenantId, storeId: kitchenMe.storeId, userId: kitchenMe.userId, deviceId, sequence: 1, orderId: createdOrderRow!.id, itemId: createdOrderRow!.items[0]!.id, expectedVersion: createdOrderRow!.version, action: 'START', createdAt: new Date().toISOString() }] } }); expect(revokedSync.status()).toBe(403);
  expect((await kitchenContext.request.post(api('/kitchen/devices/register'), { headers: { Origin: WEB_ORIGIN }, data: { deviceId } })).status()).toBe(403);
  expect((await kitchenContext.request.get(api('/orders'), { headers: { 'X-Kitchen-Device': deviceId } })).status()).toBe(403);
  await expect.poll(() => kitchenWire.closed(), { timeout: 35000 }).toBeGreaterThan(closedBeforeRevocation);
  await expect(kitchenPage.getByText('Đã kết nối', { exact: true })).not.toBeVisible();
  expect(await kitchenSocketAuthorized(kitchenPage, deviceId)).toBe(false);
  const activity = await page.request.get(api(`/admin/kitchen/devices/${deviceId}/activity`)); expect(activity.ok()).toBe(true);
  expect(await activity.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'KITCHEN_DEVICE_REVOKED' })]));
  const afterRejectedReplay = await (await page.request.get(api('/orders'))).json() as { id: string; version: number; items: { status: string }[] }[];
  expect(afterRejectedReplay.find(order => order.id === createdOrder.id)).toMatchObject({ version: createdOrderRow!.version, items: [{ status: 'PENDING' }] });
  await kitchenContext.close();
});

test('auth boundary and inventory: rejects wrong-store login and records stock adjustment in ledger', async ({ page }) => {
  if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD required; seed local fixtures first');
  const storeId = '22222222-2222-4222-8222-222222222222';
  const wrongStoreId = '99999999-9999-4999-8999-999999999999';
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@local.omnihub.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(process.env.DEMO_PASSWORD);
  await page.getByLabel('Mã cửa hàng', { exact: true }).fill(wrongStoreId);
  await submitLogin(page);
  await expect(page.getByRole('alert')).toContainText('Thông tin đăng nhập hoặc cửa hàng không đúng.');
  expect((await page.request.get(api('/auth/me'))).status()).toBe(401);

  await page.getByLabel('Mã cửa hàng', { exact: true }).fill(storeId);
  await submitLogin(page);
  await page.getByRole('button', { name: /Kho nguyên liệu/ }).click();
  await expect(page.getByRole('heading', { name: 'Kho nguyên liệu', exact: true })).toBeVisible();

  const stockTable = page.locator('table').first();
  await expect(stockTable).toContainText('Cà phê');
  const coffeeRow = stockTable.locator('tbody tr', { hasText: 'Cà phê' });
  const initialAvailable = Number((await coffeeRow.locator('td').nth(4).textContent())?.trim());

  const form = page.locator('.adjustForm');
  const reason = `E2E restock ${crypto.randomUUID().slice(0, 8)}`;
  await form.getByLabel('Lượng tăng/giảm').fill('50');
  await form.getByLabel('Lý do (ít nhất 5 ký tự)').fill(reason);
  const adjusted = page.waitForResponse(r => r.url().endsWith('/inventory/adjustments') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Ghi nhận điều chỉnh', exact: true }).click();
  expect((await adjusted).status()).toBe(201);

  await expect(page.getByRole('status')).toContainText('Đã ghi nhận trên máy chủ.');
  await expect.poll(async () => Number((await coffeeRow.locator('td').nth(4).textContent())?.trim())).toBeCloseTo(initialAvailable + 50, 3);
  const ledgerTable = page.locator('table').nth(1);
  await expect(ledgerTable.locator('tbody tr').first()).toContainText('Cà phê');
  await expect(ledgerTable.locator('tbody tr').first()).toContainText(/50(?:\.000)?/);
});

