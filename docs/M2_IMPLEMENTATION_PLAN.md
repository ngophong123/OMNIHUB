# OMNIHUB – MILESTONE 2: BACKEND IMPLEMENTATION PLAN

**Workspace:** `D:\duannuoiem\CV offline\OMNIHUB-m1`  
**Baseline HEAD:** `e79ad6fa12d0a597067b5eaa6b0a8eed60ab24b7` (`main`)  
**Căn cứ:** [`docs/M2_BACKEND_AUDIT.md`](M2_BACKEND_AUDIT.md)  
**Nguyên tắc triển khai:** Chia nhỏ thành từng PR/commit độc lập, backward-compatible trong giai đoạn chuyển tiếp với frontend M1, giữ nguyên 100% PostgreSQL ledger/financial invariants đã có, kiểm thử bằng real PostgreSQL + Redis trong CI.

---

## 1. Chiến lược phân đợt (Wave Roadmap)

Để vừa khử các rủi ro **P0** ngay lập tức, vừa tránh refactor lớn ("big-bang rewrite") gây xung đột với tests hiện có, Milestone 2 được chia thành **5 đợt (Waves)** theo thứ tự phụ thuộc kỹ thuật:

```
Wave 1a (P0 Observability & Runtime Guards: M2-T01 -> M2-T02 -> M2-T03 -> M2-T04)
   ├──▶ Wave 1b (P0 Edge & Realtime Hardening — Promoted ahead of DB Wave: M2-T09 [D-01] & M2-T10 [B-01])
   ├──▶ Wave 2 (P1 Database Invariants, Indexes, Lock Ordering & Outbox DLQ: M2-T05..M2-T07 + P2 M2-T08)
   ├──▶ Wave 3 (P1 Session Lifecycle APIs: M2-T11)
   └──▶ Wave 4 (Modular NestJS Decomposition, API Versioning & Pagination: M2-T12..M2-T13)
           └──▶ Wave 5 (Ops Alignment, Payment Port & Coverage/Stress Gates: M2-T14..M2-T16)
```

> **Reconciliation Note (P0 Scheduling):** Ban đầu `M2-T09` (`D-01`) và `M2-T10` (`B-01`) được xếp vào Wave 3 do cả hai đều phụ thuộc `M2-T01`/`M2-T02` và cùng đụng cấu hình Redis ACL (`deploy/redis-start.sh`), trong khi Wave 2 gom nhóm thay đổi PostgreSQL/Prisma. Để khử sạch toàn bộ rủi ro **P0** trước khi bước vào refactor DB/DI, lộ trình đã điều chỉnh ưu tiên `M2-T09` và `M2-T10` vào ngay **Wave 1b** (ngay sau `M2-T01` và `M2-T02`), đồng thời tách rõ `M2-T08` (`P2`) khỏi đường găng P0.

---

## 2. Chi tiết từng Task (Phân rã & Thứ tự phụ thuộc)

### WAVE 1 — Observability Core, Runtime Hardening & CommandBus Fix

#### `M2-T01` — Unified Structured Logger & `AsyncLocalStorage` Request Context `[P0 / F-02]`
- **Dependencies:** Không có (nền tảng cho mọi task sau).
- **Target files:**
  - `apps/api/src/observability/logger.ts` (mới)
  - `apps/api/src/observability/request-context.ts` (mới)
  - `apps/api/src/http-app.ts`
  - `apps/api/src/errors.ts`
  - `apps/api/src/main.ts`
  - `apps/api/src/worker.ts`
  - `apps/api/src/pilot-admin.ts`
- **Nội dung công việc:**
  - Tạo `StructuredLogger` thống nhất JSON schema (`timestamp`, `level`, `service`, `code`, `correlationId`, `errorType`, auto-redact credential paths).
  - Dùng `AsyncLocalStorage` lưu `correlationId` (chấp nhận `X-Correlation-ID` hợp lệ hoặc sinh UUID v4), `tenantId`, `storeId`, `userId` (set sau khi auth).
  - Sửa `pilot-admin.ts#acceptInvitation` để ghi `correlationId` thật vào bảng `Audit`.
  - Thay thế các `console.log`/`warn`/`error` rải rác trong `main.ts`, `http-app.ts`, `errors.ts`, `worker.ts`, `outbox.ts`, `realtime.ts`, `rate-limit.ts`.
- **Rủi ro triển khai:** Một số unit test có thể spy vào `console.log`/`console.error`; giữ output mặc định ra `process.stdout`/`process.stderr` dưới dạng single-line JSON để tương thích.
- **Test strategy:** Unit tests cho `StructuredLogger` (redaction, timestamp, AsyncLocalStorage propagation) + integration test verify `Audit.correlationId` khi `acceptInvitation`.
- **Acceptance criteria:** Mọi log dòng đơn đều có `timestamp`, `level`, `service`; zero empty `correlationId` trong HTTP `Audit` records; `rate-limit` `503` và `realtime` subscriber error đều phát JSON log cảnh báo.

#### `M2-T02` — Prometheus `/metrics` Endpoint & Golden Signals Instrumentation `[P0 / F-01]`
- **Dependencies:** `M2-T01`.
- **Target files:**
  - `apps/api/package.json` (`prom-client`)
  - `apps/api/src/observability/metrics.ts` (mới)
  - `apps/api/src/http-app.ts`
  - `apps/api/src/rate-limit.ts`
  - `apps/api/src/commands.ts`
  - `apps/api/src/outbox.ts`
  - `apps/api/src/realtime.ts`
  - `deploy/Caddyfile`
- **Nội dung công việc:**
  - Khởi tạo registry metrics: `http_requests_total`, `http_request_duration_seconds`, `rate_limit_decisions_total{prefix,outcome}`, `command_bus_attempts_total{operation,outcome}`, `outbox_pending_count`, `outbox_oldest_pending_age_seconds`, `outbox_dead_letter_total`, `realtime_connected_sockets`.
  - Expose `/metrics` chỉ trên internal check / loopback hoặc protected internal secret (chặn ở `deploy/Caddyfile` public proxy).
  - Worker định kỳ cập nhật gauge `outbox_pending_count` / `outbox_oldest_pending_age_seconds` / `outbox_dead_letter_total`.
- **Rủi ro triển khai:** High cardinality labels nếu gắn `tenantId`/`orderId` vào label Prometheus -> tuyệt đối chỉ dùng low-cardinality labels (`method`, `route_pattern`, `status_class`, `prefix`, `outcome`, `operation`).
- **Test strategy:** Unit tests assert counter/histogram increments; integration test fetch `/metrics` trả content-type `text/plain` Prometheus hợp lệ và cập nhật số đếm thực tế.
- **Acceptance criteria:** `/metrics` bị chặn qua public Caddy (`403`/`404` trên edge), truy cập được từ internal network, phản ánh chính xác HTTP requests, `429`/`503` rate-limits, `P2034` retries, và outbox lag.

#### `M2-T03` — `CommandBus` Canonical Hash, Selective `P2002` Handling & Jittered Retry `[P1 / D-03]`
- **Dependencies:** `M2-T01`, `M2-T02`.
- **Target files:**
  - `apps/api/src/commands.ts`
  - `apps/api/src/domain.ts` (helper `canonicalJson`)
  - `tests/unit/auth-and-commands.test.ts`
  - `tests/integration/m1-stabilization.test.ts`
- **Nội dung công việc:**
  - Cài đặt canonical JSON stringify (sắp xếp object keys đệ quy) khi băm idempotency payload hash.
  - Không retry `P2002` toàn cục: chỉ retry `P2002` nếu `meta.target` thuộc `CommandReceipt`; mọi `P2002` trên bảng nghiệp vụ (`CashRegister`, `StockReceipt`, `RestaurantTable`, `Payment.externalReference`, v.v.) map thẳng thành `409` nghiệp vụ rõ ràng (ở cả `command()` lẫn `publicCommand()`).
  - Thêm full jitter vào backoff retry `P2034` / `40001` / `40P01` và giới hạn total retry elapsed deadline (ví dụ tối đa ~20s tổng thể thay vì 80s).
- **Rủi ro triển khai:** Nếu Prisma adapter không luôn trả tên constraint đồng nhất trong `error.meta.target`, cần test thực tế trên PostgreSQL để assert đúng pattern matching (`CommandReceipt_pkey` hoặc column list `['tenantId', 'storeId', 'key']`).
- **Test strategy:** Unit test canonical hashing & backoff jitter; PostgreSQL integration test: (a) double-submit `StockReceipt` cùng `reference` với key khác thất bại ở lần đầu (1 attempt, không retry 4 lần); (b) simulated `P2034` retry ghi nhận metric và thành công khi resolved.
- **Acceptance criteria:** Zero retry cho business `P2002`; idempotency key hash bất biến với thứ tự key JSON; tổng thời gian chờ của một command có bounded deadline.

#### `M2-T04` — HTTP Server Timeouts, Explicit Payload Cap, Webhook Boundary & Proxy CIDR Fix `[P1 / B-04, E-02]`
- **Dependencies:** `M2-T01`.
- **Target files:**
  - `apps/api/src/main.ts`
  - `apps/api/src/http-app.ts`
  - `apps/api/src/deployment-security.ts`
  - `apps/api/src/http.ts` (`tableQrCode`)
  - `tests/unit/deployment-security.test.ts`
  - `tests/unit/errors-and-security.test.ts`
- **Nội dung công việc:**
  - Gắn `server.requestTimeout = 30_000`, `server.headersTimeout = 10_000`, `server.keepAliveTimeout = 65_000` sau `app.listen()`.
  - Cấu hình explicit JSON body limit (`express.json({ limit: '256kb' })`).
  - Cho phép CIDR prefix an toàn trong `TRUSTED_PROXY_CIDRS` (ví dụ `/8`..`/32` cho IPv4, `/32`..`/128` cho IPv6, cấm `/0` hoặc public wide ranges).
  - Tách middleware CSRF `Origin` check để không chặn `/webhooks/*` (nơi sẽ bắt buộc middleware signature HMAC riêng), trong khi giữ Origin strict cho mọi route khác.
  - Trên `GET /admin/tables/qr-code`, ưu tiên/ép header `X-QR-Token` (kiểm tra frontend `apps/web` có còn dùng query không trước khi xóa hẳn hoặc chỉ hỗ trợ có deprecation flag).
- **Rủi ro triển khai:** Kiểm tra frontend/E2E tests có request nào vượt `256kb` (ví dụ `kitchenSyncSchema`) hay gọi `qr-code?token=` để không làm gãy M1 E2E.
- **Test strategy:** Unit tests CIDR validator + payload size `413` test + Origin bypass denial trên non-webhook vs webhook signature guard.
- **Acceptance criteria:** `TRUSTED_PROXY_CIDRS=172.29.87.0/24` boot hợp lệ trong `NODE_ENV=production`; `0.0.0.0/0` bị reject; server timeouts & 256kb payload limit hoạt động đúng.

---

### WAVE 2 — Database Invariants, Indexes, Lock Ordering & Outbox Persistent DLQ

#### `M2-T05` — Schema Indexes, Partial Unique Constraints, DB Role Timeouts & Retention Job `[P1 / C-01, C-05, B-03, C-02]`
- **Dependencies:** `M2-T01`.
- **Target files:**
  - `prisma/schema.prisma`
  - `prisma/migrations/202611160001_m2_indexes_and_uniques/migration.sql` (mới)
  - `deploy/postgres-init.sh`
  - `apps/api/src/maintenance.ts` (mới)
  - `apps/api/src/catalog-operations.ts` (`createCategory`/`updateCategory` `deletedAt: null`)
  - `apps/api/src/pilot-admin.ts` (check trong tx)
- **Nội dung công việc:**
  - Thêm index `Movement(tenantId, storeId, createdAt DESC)`.
  - Thêm partial unique index `StoreInvitation(tenantId, storeId, lower(email)) WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`.
  - Thêm functional partial unique indexes cho catalog active (`Category`, `Station`, `Ingredient`, `Product` với `WHERE "deletedAt" IS NULL`) và sửa `createCategory`/`updateCategory` lọc `deletedAt: null` cho `peers`.
  - Trong `deploy/postgres-init.sh`, đặt `statement_timeout = '15s'`, `idle_in_transaction_session_timeout = '20s'`, `lock_timeout = '5s'` cho `omnihub_app`.
  - Tạo batch retention cleanup (`Outbox` delivered > 7 ngày, `Session` / `TableSession` expired > 7 ngày, `CommandReceipt` > 30 ngày) chạy theo batch `LIMIT 1000` qua maintenance timer trong `worker.ts` (không chạm `Audit`, `Movement`, `Payment`, `Refund`).
- **Rủi ro triển khai:** Migration tạo unique index trên dữ liệu cũ nếu có trùng lặp -> thêm pre-check hoặc chỉ mục chuẩn sạch; thay đổi `postgres-init.sh` chỉ tác dụng với DB mới tạo nên cần tài liệu hóa lệnh `ALTER ROLE` cho staging DB đang chạy.
- **Test strategy:** PostgreSQL integration tests verify migration apply sạch, tạo lại archived category trùng tên thành công, parallel `createInvitation` cùng email trả 1 thành công + 1 `409`, và batch cleanup chỉ xóa expired rows.
- **Acceptance criteria:** `EXPLAIN` truy vấn `Movement` theo store dùng index scan mới; archived categories không chặn tạo mới cùng tên; cleanup job an toàn với immutable tables.

#### `M2-T06` — Canonical Lock Ordering & Cash Refund Shift Semantics `[P1 / C-03, C-04]`
- **Dependencies:** `M2-T05`.
- **Target files:**
  - `apps/api/src/operations.ts`
  - `apps/api/src/payments.ts`
  - `apps/api/src/cash-shifts.ts`
  - `packages/contracts/src/index.ts` (nếu mở rộng optional `cashShiftId` cho `refundDecisionSchema`)
  - `tests/integration/operations.test.ts` & `tests/integration/m1-stabilization.test.ts` (hoặc file test concurrency mới)
- **Nội dung công việc:**
  - Chuẩn hóa thứ tự khóa hàng toàn hệ thống trong mọi multi-table tx (`CashShift` -> `Order` -> `OrderItem` / sorted `Balance` -> `Payment` -> `Refund`).
  - Sửa `Operations.cash`, `Payments.record`, `Payments.verify`, `Payments.failPending`, `Payments.decideRefund`, `CashShifts.close/move` để lock đúng thứ tự (cụ thể: với `Payments.record` & `Payments.decideRefund` CASH, lấy/lock `CashShift` trước `Order`/`Payment`/`Refund` hoặc xác định shift trước rồi lock theo đúng chiều duy nhất).
  - Khắc phục `Payments.decideRefund`: khi hoàn tiền `CASH`, cho phép dùng `payment.cashShiftId` nếu ca đó đang `OPEN` hoặc `cashShiftId` được manager chỉ định thuộc cùng store và đang `OPEN` (fallback sang ca mở của current actor), đồng thời vẫn ghi `actorId = current.userId` vào `CashMovement` để đối soát đúng két thực tế.
- **Rủi ro triển khai:** Thay đổi behavior `decideRefund` cần đảm bảo giữ nguyên toàn bộ test M1 hiện có (nơi manager/cashier mở ca của mình) đồng thời mở thêm case manager duyệt hoàn tiền cho ca của cashier khác.
- **Test strategy:** Integration tests cho mixed lock contention (`Promise.all` record cash + verify bank + decideRefund + closeShift) xác nhận zero PostgreSQL `40P01` deadlock, và test manager duyệt cash refund từ ca mở của cashier.
- **Acceptance criteria:** Không phát sinh deadlock `40P01` dưới concurrent stress test; `CashShift.expectedAmount` khớp chuẩn sau cash refund do manager duyệt cho ca của cashier.

#### `M2-T07` — Outbox Persistent Dead-Letter Queue (DLQ) & Worker Redis `enableOfflineQueue: false` `[P1 / D-02]`
- **Dependencies:** `M2-T01`, `M2-T02`.
- **Target files:**
  - `prisma/schema.prisma`
  - `prisma/migrations/202611160002_outbox_dlq/migration.sql` (mới)
  - `apps/api/src/outbox.ts`
  - `apps/api/src/worker.ts`
  - `tests/unit/realtime-and-outbox.test.ts`
  - `tests/integration/m1-stabilization.test.ts`
- **Nội dung công việc:**
  - Thêm cột vào `Outbox`: `attempts Int @default(0)`, `lastError String?`, `deadLetteredAt DateTime?`, `deadLetterReason String?` + partial index `WHERE "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL`.
  - Bỏ phụ thuộc vào volatile RAM `quarantinedIds` cho các event sai schema/contract: ghi thẳng `deadLetteredAt = now()`, `deadLetterReason = 'INVALID_CONTRACT_EVENT'` vào PostgreSQL trong batch tx và tăng metric `outbox_dead_letter_total` + log `OUTBOX_DEAD_LETTERED`.
  - Cập nhật `worker.ts`: đặt `enableOfflineQueue: false` cho Redis client và log structured warning có rate-aware khi Redis lỗi.
  - Thêm helper/admin query xem và requeue DLQ rows có kiểm soát (nếu cần).
- **Rủi ro triển khai:** Cần giữ nguyên performance `FOR UPDATE SKIP LOCKED` và batch time budget `10s` trong `outbox.ts`.
- **Test strategy:** Unit + PostgreSQL integration tests: tạo malformed `Outbox` row -> chạy `processOutboxBatch` -> row chuyển `deadLetteredAt != null` và batch kế tiếp/worker restart không pick lại; Redis disconnect test verify fail-fast.
- **Acceptance criteria:** Poison rows không bao giờ retry lại sau worker restart; Redis outage kích hoạt exponential backoff ngay lập tức không buffer command trên RAM.

#### `M2-T08` — Sửa Idempotent Retry cho `QrOrdering.createTable` & `regenerate` `[P2 / D-04]`
- **Dependencies:** `M2-T03`.
- **Target files:**
  - `apps/api/src/qr-ordering.ts`
  - `apps/api/src/crypto-envelope.ts` (mới hoặc helper AES-256-GCM dùng `QR_TOKEN_SECRET` có context tách biệt)
  - `tests/integration/operations.test.ts`
- **Nội dung công việc:**
  - Thay vì trả lỗi `409 QR_CREATED_RETRY_WITH_NEW_KEY` khi `CommandReceipt` replay, mã hóa authenticated (AES-256-GCM với key dẫn xuất từ `QR_TOKEN_SECRET` qua HKDF/SHA-256) phần `token` trước khi lưu trong `CommandReceipt.response` (vẫn KHÔNG lưu plaintext token vào DB hay `Audit` details), và giải mã trả lại nguyên vẹn response khi retry cùng `Idempotency-Key`.
- **Rủi ro triển khai:** Khi `QR_TOKEN_SECRET` xoay vòng (rotation), receipt cũ trước khi xoay không giải mã được -> fallback an toàn trả lỗi `409 QR_RETRY_TOKEN_UNAVAILABLE` nếu decryption tag fail.
- **Test strategy:** Integration test gọi `createTable` và `regenerate` 2 lần với cùng `Idempotency-Key`, assert lần 2 trả `200/201` cùng `token` dùng được trên `/public/qr/:token/menu`.
- **Acceptance criteria:** Safe idempotent retry hoạt động 100% cho `createTable` & `regenerate` mà không lưu plaintext credential trong DB.

---

### WAVE 3 — Multi-Replica Realtime Adapter & Auth/Session Hardening

#### `M2-T09` — Socket.IO Multi-Replica `@socket.io/redis-adapter`, Subscriber Resilience & Instant Revocation `[P0 / D-01]`
- **Dependencies:** `M2-T01`, `M2-T02`.
- **Target files:**
  - `apps/api/package.json` (`@socket.io/redis-adapter`)
  - `apps/api/src/realtime.ts`
  - `apps/api/src/http.ts` (`/ready`)
  - `deploy/redis-start.sh` (kiểm tra ACL Redis đủ lệnh cho adapter: e.g. `publish`/`subscribe`/`psubscribe`/`punsubscribe`/`unsubscribe`!)
  - `tests/redis/api-replicas.test.ts` (hoặc thêm `tests/redis/realtime-replicas.test.ts`)
- **Nội dung công việc:**
  - Gắn `@socket.io/redis-adapter` (dùng pub/sub dedicated Redis clients với prefix riêng nằm trong ACL allowlist của `deploy/redis-start.sh`, e.g., mở rộng ACL channel pattern `&omnihub.events &socket.io#*` và `+psubscribe +punsubscribe`!).
  - Log có cấu trúc khi Redis subscriber `error`/`ready`/`reconnecting` và đưa `realtimeRedisReady()` vào `/ready` check (hoặc status field).
  - Xử lý event `session.revoked` / `kitchen.device.changed` từ Outbox để đóng ngay lập tức socket có `tokenHash`/`deviceId` tương ứng thay vì đợi 30s.
- **Rủi ro triển khai:** **Quan trọng:** `deploy/redis-start.sh` hiện giới hạn ACL rất chặt (`~omnihub:rate:* &omnihub.events -@all +ping ... +publish +subscribe +unsubscribe`). Nếu `@socket.io/redis-adapter` dùng `psubscribe` hoặc channel `socket.io#*`, ACL Redis sẽ từ chối `NOPERM` nếu không cập nhật `deploy/redis-start.sh` và test trực tiếp với ACL giống staging!
- **Test strategy:** Real Redis multi-replica HTTP API test (`2` API processes trên 2 port) mô phỏng round-robin polling + WebSocket connect và Outbox event broadcast + device revocation disconnect ngay lập tức.
- **Acceptance criteria:** Hai API processes chia sẻ room/events qua `@socket.io/redis-adapter` không lỗi `Session ID unknown`; Redis ACL staging cho phép adapter chạy sạch không `NOPERM`.

#### `M2-T10` — Dual-Key Auth Rate Limit & Per-Account Brute-Force Protection `[P0 / B-01]`
- **Dependencies:** `M2-T01`, `M2-T02`.
- **Target files:**
  - `apps/api/src/rate-limit.ts`
  - `apps/api/src/auth.ts`
  - `apps/api/src/main.ts`
  - `deploy/redis-start.sh` (nếu thêm key prefix nằm ngoài `omnihub:rate:*`, hãy giữ nằm gọn trong `omnihub:rate:*` để tương thích ACL!)
  - `tests/redis/shared-rate-limit.test.ts` & `tests/unit/rate-limit.test.ts`
- **Nội dung công việc:**
  - Giữ Redis key trong namespace `omnihub:rate:*` để tương thích ACL staging.
  - Bổ sung failed-attempt tracking theo `account:{digest(email)}` (chỉ tăng khi `verifyPassword` thất bại; reset/xóa hoặc không tăng khi login thành công; lưu ý ACL `del` đang bị cấm nên dùng bucket cửa sổ cố định/exponential window hoặc TTL keys `omnihub:rate:v1:acct-fail:{emailDigest}:{epochWindow}` / Lua script set `PEXPIRE`).
  - Nâng ngưỡng IP `/auth/login` đủ rộng cho quán đông qua NAT (ví dụ cấu hình riêng `AUTH_LOGIN_IP_LIMIT` mặc định 30–60/phút) và áp chặt ngưỡng theo `(account)` (ví dụ 8–10 lần sai trong 15 phút -> `429 ACCOUNT_LOCKED_RETRY_LATER`).
  - Áp rate limit chặt (`10/min`) cho `/public/invitations/` tương đương `/auth/login`.
- **Rủi ro triển khai:** Lưu ý ACL Redis trong `deploy/redis-start.sh#L5` **cấm lệnh `DEL`**! Thiết kế reset counter không được dùng `DEL` (có thể dùng Lua `SET key 0 PX 1` hoặc `PEXPIRE key 1` nếu có `+set` hoặc giữ 2 key `generation` không cần `DEL` — kiểm tra kỹ ACL trước khi viết Lua!).
- **Test strategy:** Unit + Redis integration test mô phỏng distributed IPs tấn công 1 email -> khóa account; login khác email từ cùng IP NAT vẫn thành công.
- **Acceptance criteria:** Không phát sinh lệnh Redis bị cấm bởi ACL; brute-force 1 email từ nhiều IP bị chặn `429`; không khóa chéo user khác chung IP NAT.

#### `M2-T11` — Session Lifecycle APIs (`logout-all`, `revoke-sessions`, `switch-store`) `[P1 / B-02]`
- **Dependencies:** `M2-T09`.
- **Target files:**
  - `apps/api/src/auth.ts`
  - `packages/contracts/src/index.ts`
  - `apps/api/src/http.ts` (hoặc `AuthModule` ở Wave 4)
  - `tests/integration/operations.test.ts` (hoặc `tests/integration/auth-lifecycle.test.ts`)
- **Nội dung công việc:**
  - Thêm `POST /auth/logout-all`: xóa toàn bộ `Session` của `ctx.userId`, clear cookie hiện tại, ghi `Audit` + `Outbox` (`session.revoked`).
  - Thêm `POST /admin/members/:userId/revoke-sessions` (yêu cầu quyền `admin` và kiểm tra user có membership trong `storeId` hiện tại; `MANAGER` không được revoke `OWNER`).
  - Thêm `POST /auth/switch-store`: kiểm tra `Membership` của `ctx.userId` tại `targetStoreId` (cùng `tenantId`), cấp token cookie mới (xoay `tokenHash`, xóa session cũ) và trả metadata store mới.
- **Rủi ro triển khai:** `switch-store` phải kiểm tra `user.active` và cấm chuyển sang tenant khác nếu rule là strict intra-tenant switch (hoặc kiểm tra membership cụ thể); đảm bảo RBAC không leo thang (`MANAGER` không revoke session `OWNER`).
- **Test strategy:** Integration tests cho `logout-all`, `revoke-sessions` (chặn cross-store & `MANAGER -> OWNER`), và `switch-store` + kiểm tra token cũ invalid ngay lập tức.
- **Acceptance criteria:** Token cũ trả `401` ngay sau `logout-all` / `revoke-sessions` / `switch-store`; cross-tenant switch trả `403`.

---

### WAVE 4 — Modular NestJS Decomposition, API Versioning & Pagination

#### `M2-T12` — Tách Monolith `http.ts` thành NestJS Feature Modules + DI + Guards/Pipes `[P1 / A-01, A-02]`
- **Dependencies:** `M2-T01`, `M2-T03`, `M2-T06`, `M2-T11`.
- **Target files:**
  - `apps/api/src/database/prisma.module.ts` (mới)
  - `apps/api/src/common/guards/` (`session.guard.ts`, `permission.guard.ts`, `kitchen-device.guard.ts`) (mới)
  - `apps/api/src/common/pipes/zod-validation.pipe.ts` (mới)
  - `apps/api/src/modules/` (`auth/`, `catalog/`, `orders/`, `kitchen/`, `payments/`, `cash-shifts/`, `qr-ordering/`, `admin/`, `health/`)
  - `apps/api/src/http.ts` (giữ thin compatibility barrel hoặc thay thế bởi `app.module.ts`)
  - `apps/api/src/http-app.ts`
- **Nội dung công việc:**
  - Đưa `PrismaClient`, `StructuredLogger`, `MetricsService` vào `@Global()` NestJS providers.
  - Chuyển toàn bộ service (`Operations`, `CatalogOperations`, `CashShifts`, `Payments`, `QrOrdering`, `PilotAdmin`, và `KitchenService` mới) sang `@Injectable()` qua constructor DI thay cho module-level `new`.
  - Di chuyển toàn bộ logic transaction/query từ `ApiController` (`registerKitchenDevice`, `assignKitchenDevice`, `revokeKitchenDevice`, `listKitchenDevices`, `pilotReadiness`, `orders`, `inventory`, `report`) xuống Services tương ứng; đưa `assignKitchenDevice` & `revokeKitchenDevice` qua `CommandBus` (phát `Outbox`).
- **Rủi ro triển khai:** Refactor nhiều file dễ làm lệch import path của `tests/unit/*` và `tests/integration/*` nếu test đang import trực tiếp từ `apps/api/src/...`. Giữ re-export hoặc update import có kiểm soát trong cùng PR, chia thành 2 sub-PR nếu cần (PR 4a: Common/DI/Health/Auth/Kitchen; PR 4b: Catalog/Orders/Payments/Cash/QR).
- **Test strategy:** Toàn bộ suite `typecheck`, `lint`, `unit`, `integration`, `redis`, `e2e` chạy pass không sửa assertions nghiệp vụ.
- **Acceptance criteria:** Zero raw `db.*` calls trong bất kỳ `@Controller()` nào; zero top-level `new Service(db)` singletons; `AppModule` lắp ghép sạch qua NestJS DI.

#### `M2-T13` — API Versioning (`/v1` Prefix) & Bounded Pagination Standardization `[P1 / E-01]`
- **Dependencies:** `M2-T12`.
- **Target files:**
  - `apps/api/src/http-app.ts` (global prefix / dual-route compatibility)
  - `packages/contracts/src/index.ts` & `packages/contracts/src/admin.ts`
  - `apps/api/src/modules/orders/`, `inventory/`, `cash-shifts/`, `admin/`, `qr-ordering/`
- **Nội dung công việc:**
  - Bật URI versioning chuẩn `/v1/...` (hỗ trợ tạm thời unversioned paths với header `Deprecation: true` hoặc route alias cho frontend M1 nếu frontend chưa nâng cấp sang `/v1`, tránh break E2E Playwright).
  - Bổ sung pagination (`cursor` / `limit <= 100`) cho `GET /orders`, `GET /inventory`, `GET /inventory/movements` (thống nhất behavior với `/admin/inventory/movements`), `GET /admin/invitations`, `GET /admin/kitchen/devices`, `GET /admin/tables`.
  - Tách chi tiết `movements`/`payments` ra khỏi list `GET /cash/shifts` (chỉ trả summary counts + endpoint `GET /cash/shifts/:id` lấy chi tiết phân trang), giữ backward-compatibility nếu cần qua query param hoặc version `/v1`.
- **Rủi ro triển khai:** Thay đổi payload `GET /cash/shifts` hoặc `GET /orders` trên route cũ không `/v1` có thể làm gãy E2E frontend hiện tại! Do đó áp dụng strict paginated shapes trên `/v1/...` và thêm bounded limits an toàn cho unversioned routes.
- **Test strategy:** Integration tests verify pagination boundaries (`limit > 100` clamped/rejected, `cursor` trả đúng trang không trùng/mất row) trên `/v1/*` và backward-compatibility tests cho E2E.
- **Acceptance criteria:** Không còn endpoint nào load unbounded rows hay `take: 100` nested hàng chục nghìn payments; `/v1/health`, `/v1/orders`, v.v. hoạt động đầy đủ.

---

### WAVE 5 — Operations Alignment, Payment Port & Coverage/Stress Verification

#### `M2-T14` — CI/Staging PostgreSQL Version Alignment & WAL/PITR Design `[P1 / G-01]`
- **Dependencies:** Độc lập (có thể chạy song song Wave 3–4).
- **Target files:**
  - `.github/workflows/ci.yml`
  - `deploy/compose.staging.yml`
  - `package.json` (đánh giá `embedded-postgres` beta dependency)
  - `deploy/backup/` & `docs/BACKUP_AND_RECOVERY.md`
- **Nội dung công việc:**
  - Đồng bộ major version PostgreSQL giữa CI (`.github/workflows/ci.yml`) và staging (`deploy/compose.staging.yml`).
  - Thiết kế & bổ sung cấu hình/script thử nghiệm cho PostgreSQL WAL archiving / PITR (`archive_mode = on`, `pgBackRest` hoặc continuous WAL + verification drill script) nhằm hạ RPO từ 5–15 phút (`pg_dump`) xuống mức giao dịch liên tục; cập nhật tài liệu recovery RPO/RTO thực tế.
- **Rủi ro triển khai:** Bật `archive_mode` trong Postgres yêu cầu restart container và cấp quyền đọc WAL directory cẩn thận cho backup service.
- **Test strategy:** Chạy full CI workflow + shell tests trong `deploy/backup/test-*.sh` và test PITR restore recovery checkpoint trên container staging test.
- **Acceptance criteria:** CI và staging chạy cùng major version PostgreSQL; backup/PITR workflow pass kiểm tra shell syntax (`sh -n`) và restore drill verification.

#### `M2-T15` — Payment Gateway Port & Signed Webhook Verification Pipeline `[P2 / G-02]`
- **Dependencies:** `M2-T04`, `M2-T12`.
- **Target files:**
  - `apps/api/src/card-provider.ts` -> `apps/api/src/modules/payments/payment-gateway.port.ts`
  - `apps/api/src/modules/payments/webhook.controller.ts` (mới)
  - `apps/api/src/modules/payments/payments.service.ts`
  - `tests/integration/payment-webhooks.test.ts` (mới)
- **Nội dung công việc:**
  - Tách interface `PaymentGatewayPort` hỗ trợ intent creation + webhook event parsing/verification.
  - Cài đặt `/webhooks/payments/:provider` với HMAC-SHA256 constant-time signature verification (`timingSafeEqual`), replay timestamp window check (e.g. `<= 300s`), và idempotent settlement theo `externalReference` / `providerEventId`.
  - Bổ sung job/command thu dọn hoặc đánh dấu `FAILED` cho `BANK_TRANSFER` / `CARD` payment ở trạng thái `PENDING` quá thời gian TTL cấu hình.
- **Rủi ro triển khai:** Raw request body preservation cần thiết để verify HMAC signature chính xác (gắn `rawBody: true` trong `NestFactory.create` hoặc `express.json({ verify })`).
- **Test strategy:** Integration tests cho valid signed webhook -> `SETTLED` + Order `PAID`/`COMPLETED`, duplicate webhook -> idempotent, tampered signature -> `401/403`, stale timestamp -> `401`, expired pending payment cleanup.
- **Acceptance criteria:** Webhook controller không dùng `Origin` header, verify `rawBody` HMAC fail-closed, và cập nhật Payment/Order atomically thông qua `CommandBus` hoặc transactional guard tương đương.

#### `M2-T16` — Concurrency Deadlock Stress Suite, Security Abuse Suite & Nâng CI Coverage Gates `[P1 / H-01, H-02]`
- **Dependencies:** Toàn bộ Wave 1–5 (`M2-T01` .. `M2-T15`).
- **Target files:**
  - `vitest.config.ts`
  - `tests/integration/concurrency-stress.test.ts` (mới)
  - `tests/integration/security-boundaries.test.ts` (mới)
  - `tests/redis/realtime-replicas.test.ts` (mới)
  - `scripts/load-smoke.ts` (hoặc `k6` profile tùy chọn, không chạy giả lập kết quả)
- **Nội dung công việc:**
  - Bổ sung concurrency stress tests chạy song song trên PostgreSQL thật (`record CASH`, `verify BANK_TRANSFER`, `decideRefund`, `closeShift`, `item START/CANCEL`, `acceptOrder` cùng lúc trên 1 store).
  - Bổ sung security abuse tests (per-account lockout từ nhiều IP, cross-tenant ID injection trên từng endpoint, oversized body `413`, invalid webhook HMAC, revoked kitchen device instant WS disconnect).
  - Bổ sung multi-replica Socket.IO Redis adapter test trên 2 API processes.
  - Nâng coverage threshold trong `vitest.config.ts`: global CI gate (mục tiêu `lines >= 75, branches >= 70, functions >= 75, statements >= 75`) và đặt per-file minimum thresholds cho các core modules (`commands.ts`, `operations.ts`, `payments.ts`, `cash-shifts.ts`, `outbox.ts`, `realtime.ts`, `errors.ts`, `pilot-admin.ts`, `qr-ordering.ts`).
- **Rủi ro triển khai:** Concurrency test chạy chậm hoặc flaky nếu DB pool nhỏ -> điều chỉnh số worker concurrency phù hợp với pool/CI runner (ví dụ 8–16 concurrent promises) và assert invariant tổng tiền/tồn kho thay vì phụ thuộc thứ tự thắng thua ngẫu nhiên.
- **Test strategy:** Chạy full `pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage:ci && pnpm test:redis && pnpm test:e2e:ci`.
- **Acceptance criteria:** Zero flaky tests trong 3 lần chạy liên tiếp; `test:coverage:ci` vượt mọi per-file và global thresholds mới; mọi invariants tài chính/tồn kho đều giữ nguyên dưới concurrency.

---

## 3. Chiến lược Kiểm thử tổng thể (Test Strategy)

| Tầng Test | Hạ tầng thực thi | Trách nhiệm kiểm chứng trong M2 |
| :--- | :--- | :--- |
| **Unit Tests** (`tests/unit/`) | Node.js / Vitest | Canonical JSON hashing, jitter backoff math, CIDR validator, logger redaction, metric counters, dual-key rate-limit logic, pure domain & contract schemas. |
| **PostgreSQL Integration** (`tests/integration/`) | Real Postgres (CI) | Lock ordering zero-deadlock under contention, `CommandBus` selective `P2002` no-retry, `Outbox` persistent DLQ qua restart giả lập, archived category name reuse, concurrent `StoreInvitation` unique constraint, `decideRefund` across cashier shift, batch retention cleanup, paginated endpoints, signed payment webhooks. |
| **Redis Integration** (`tests/redis/`) | Real Redis 7 + ACL + Multi-process API | Shared dual-key auth brute-force lockout across IPs/replicas, `@socket.io/redis-adapter` polling/WS events across 2 API processes, instant socket disconnect on `session.revoked`/`kitchen.device.changed`, Outbox worker Redis outage backoff (`enableOfflineQueue: false`). |
| **E2E Regression** (`tests/e2e/`) | Postgres + Redis + API + Worker + Next.js + Playwright | Toàn bộ 10 luồng người dùng M1 vẫn pass 100% không breaking change khi API refactor sang NestJS DI và thêm version `/v1`. |
| **Ops & Security CI** (`.github/workflows/`) | `security.yml` + `deploy/backup/test-*.sh` | `pnpm audit --prod`, CodeQL, `sh -n` mọi backup/DR/init scripts, restic & PITR restore verification. |

---

## 4. Definition of Done (DoD) cho Toàn Milestone 2

Milestone 2 chỉ được đánh giá hoàn tất (`DONE`) khi thỏa mãn **đầy đủ** các tiêu chí sau với bằng chứng chạy thực tế trên CI:

1. **Architecture & API:** Không còn monolithic inline Prisma transactions/singletons trong controller; toàn bộ endpoints đi qua NestJS DI, Guards/Pipes, có `/v1` versioning, pagination có giới hạn trên mọi list endpoints, và HTTP server timeouts/payload limits tường minh.
2. **Security & Identity:** Bảo vệ login theo cả IP và Account (không dính lỗi Redis ACL `DEL`), có `logout-all`/`revoke-sessions`/`switch-store`, `TRUSTED_PROXY_CIDRS` hỗ trợ CIDR chuẩn (cấm `/0`), và `/webhooks/*` tách biệt khỏi browser `Origin` CSRF check bằng HMAC + replay guard.
3. **Database & Financial Concurrency:** Đủ index `Movement(tenantId, storeId, createdAt DESC)`, partial unique indexes cho pending invitations & active catalog, chuẩn hóa lock ordering không deadlock `40P01` dưới concurrent stress test, DB role `statement_timeout`/`lock_timeout` hoạt động, và `decideRefund` hỗ trợ chuẩn hoàn tiền mặt từ ca thu ngân mở.
4. **Distributed Systems & Realtime:** `@socket.io/redis-adapter` vận hành đa replica ổn định (kèm ACL Redis khớp staging), Outbox DLQ bền vững trên PostgreSQL (`deadLetteredAt`) không dựa RAM khi restart, `CommandBus` canonical hash + không retry `P2002` nghiệp vụ, và safe idempotent retry cho QR table ops.
5. **Observability & Operations:** Structured JSON logging thống nhất có `AsyncLocalStorage` `correlationId`, endpoint nội bộ `/metrics` Prometheus đầy đủ golden signals + outbox lag, `deploy/Caddyfile` chặn public `/metrics`, Postgres version đồng bộ giữa CI và Staging, và có chiến lược/kiểm chứng PITR/WAL.
6. **Verification Gate:** `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:coverage:ci` (với coverage thresholds nâng lên `>= 70–75%` kèm per-file core gates), `pnpm test:redis`, `pnpm test:e2e:ci`, và `.github/workflows/security.yml` đều pass 100% không bỏ qua hoặc nới lỏng assertion.
