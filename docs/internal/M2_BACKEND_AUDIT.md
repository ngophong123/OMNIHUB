# OMNIHUB – MILESTONE 2: BACKEND ARCHITECTURE & RELIABILITY AUDIT

- **Workspace:** `D:\duannuoiem\CV offline\OMNIHUB-m1`
- **Branch / Baseline HEAD:** `main` @ `e79ad6fa12d0a597067b5eaa6b0a8eed60ab24b7` (post PR #3 / M1 merge)
- **Vai trò đánh giá:** Senior Backend Architect / Staff Software Engineer / Reliability Engineer
- **Phương pháp:** Đọc trực tiếp source code `apps/api/src/*`, `packages/contracts/src/*`, `prisma/schema.prisma`, `prisma/migrations/*`, `deploy/*`, `.github/workflows/*`, `vitest.config.ts`, `package.json`, và thống kê/kiểm tra test suites trong `tests/*`. Không chỉnh sửa code, không suy đoán ngoài dữ liệu đã kiểm chứng.

---

## 1. Tóm tắt điều hành (Executive Summary)

Sau Milestone 1 (`e79ad6f`), OMNIHUB đã có **lõi transactional và invariant cơ bản vững** đối với một hệ thống F&B SaaS giai đoạn pilot đơn-instance / isolated-host:
- **Điểm mạnh thực tế đã kiểm chứng:**
  - Scope tenant/store kép (`tenantId`, `storeId`) thông qua composite foreign keys trong PostgreSQL (`prisma/schema.prisma`) và reauthorization trong `Serializable` transaction (`apps/api/src/auth.ts#L17-L22`, `apps/api/src/commands.ts#L19`).
  - Financial & ledger integrity bằng DB check constraints và triggers bất biến (`reject_ledger_mutation`, `protect_closed_cash_shift`, `payment_status_transition`, `refund_status_transition`, `balance_nonnegative_available`) cùng `BigInt` largest-remainder allocation (`apps/api/src/domain.ts`) và `Decimal` recipes (`apps/api/src/catalog-domain.ts`).
  - Outbox worker có `FOR UPDATE SKIP LOCKED`, batch time budget `10s` trong transaction deadline `15s` (`apps/api/src/outbox.ts`), Socket.IO O(1) batched revalidation (`apps/api/src/realtime.ts`), fail-closed deployment config guard (`apps/api/src/deployment-security.ts`), và Redis Lua rate limiter (`apps/api/src/rate-limit.ts`).

- **Lý do chưa đạt chuẩn Senior Production SaaS (trước khi xử lý M2):**
  1. **Kiến trúc ứng dụng phẳng, thiếu module boundary:** Toàn bộ ~45+ endpoints, validation thủ công, raw `$transaction` cho kitchen devices, và truy vấn Prisma trực tiếp nằm chung trong một controller duy nhất [`apps/api/src/http.ts`](../../apps/api/src/http.ts), hoàn toàn không dùng NestJS Dependency Injection, Guards/Pipes, hay API versioning (`/v1`).
  2. **Thiếu năng lực scale ngang & resilience ở runtime:** Socket.IO chưa có `@socket.io/redis-adapter` (polling broken nếu nhiều API replicas không sticky session); `Outbox` quarantine chỉ lưu trên RAM (`Set` tối đa 1.000 IDs) không có persistent DLQ/retry counter hay retention pruning; `CommandBus` retry cả lỗi unique violation `P2002` không có jitter và có thể giữ HTTP thread tới ~80s.
  3. **Bảo mật & Identity vận hành còn khoảng trống:** Không có per-account login throttling (chỉ theo IP -> rủi ro credential stuffing qua proxy hoặc khóa nhầm toàn bộ quán ăn chung NAT); không có session revocation/list/switch-store/cleanup; `TRUSTED_PROXY_CIDRS` cấm CIDR subnet khác `/32` và `/128`; global CSRF Origin gate chặn luôn `/webhooks/*` server-to-server.
  4. **Observability & Production Ops mới ở mức log JSON tối thiểu:** Thiếu hoàn toàn metrics (`/metrics` Prometheus / OpenTelemetry), DB pool/statement timeout tuning, HTTP server timeouts, structured logger thống nhất, và payment adapter mới chỉ là sandbox stub (`CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED`).
  5. **DR & CI consistency còn hở:** Backup chỉ dùng `pg_dump` chu kỳ 300s (không có WAL continuous archiving / PITR); CI chạy Postgres `17-alpine` trong khi staging chạy `postgres:18-alpine`; coverage threshold tổng thể ở CI mới ở mức thấp (`lines: 55`, `branches: 48`, `functions: 45`, `statements: 45`) và chưa ép coverage cho các file orchestration chính.

---

## 2. Ma trận đánh giá theo 8 miền (Domain Scorecard)

| Miền | Phạm vi | Trạng thái | Tóm tắt bằng chứng |
| :--- | :--- | :---: | :--- |
| **A. Architecture & Modularity** | NestJS DI, layering, shared helpers | `PARTIAL` | Pure domain tách tốt (`domain.ts`, `catalog-domain.ts`), nhưng `http.ts` là monolithic `@Controller()` tự `new` services, lẫn Prisma queries với transport, chưa có DI & versioning. |
| **B. AuthN, AuthZ & Multi-Tenancy** | Session, RBAC, isolation, brute-force | `PARTIAL` | Scrypt + timing fallback, reauth trong tx, composite tenant/store FK mạnh; nhưng thiếu per-account lockout, session management/TTL purge, multi-store switch, và role matrix cho device sync còn lỏng lẻo. |
| **C. Database & Data Integrity** | Schema, indexes, transactions, locks | `PARTIAL` | Check constraints & immutable ledger triggers xuất sắc; nhưng thiếu index `Movement(tenantId, storeId, createdAt)`, `uniqueName` đọc full table vào JS, thiếu partial unique index cho `StoreInvitation` pending và category/station/product active, nguy cơ deadlock lock order chéo. |
| **D. Distributed Systems & Reliability** | Idempotency, Outbox, Realtime, Redis | `PARTIAL` | M1 đã fix Outbox time budget + Lua limiter + replica shared limit test; nhưng thiếu `@socket.io/redis-adapter`, `quarantinedIds` volatile trên RAM, `worker.ts` thiếu `enableOfflineQueue: false`, `CommandBus` retry sai `P2002`, `qr-ordering` vỡ idempotent retry (`409`). |
| **E. API Design & Runtime Reliability** | Pagination, timeouts, validation, webhooks | `PARTIAL` | Zod `parse()` chặt ở contracts; nhưng nhiều list endpoints unbounded hoặc `take: 100/200`, offset pagination sâu, thiếu HTTP server timeouts & explicit payload limit, Origin gate chặn webhooks, `/ready` chưa kiểm soát query/timeout riêng. |
| **F. Observability, Metrics & Errors** | Logging, tracing, metrics, error filter | `PARTIAL` | `Errors` filter + `accessLogPath` che token rất tốt; nhưng log rải rác bằng `console.*`, 429/503 rate-limit im lặng, `acceptInvitation` ghi `correlationId: ''`, `realtime` nuốt lỗi Redis, bằng 0 metrics (`/metrics`, pool, lag). |
| **G. Production Readiness & Ops** | Docker, secrets, CI/CD, backup/DR, payment | `PARTIAL` | Container hardening (`read_only`, `cap_drop: ALL`, DB least-privilege roles, Restic verify) tốt; nhưng CI Postgres 17 vs Staging Postgres 18, không có WAL/PITR, không có DB pool/statement timeout config, card payment chưa tích hợp provider thật. |
| **H. Testing Architecture & Gaps** | Unit, Integration, Redis, E2E, Load/Chaos | `PARTIAL` | 50 unit test cases executed across 6 files (41 static `it`/`it.each` declarations; expanded to 50 by 9 parameterized cases in `deployment-security.test.ts`) + 32 PG integration + 2 Redis + 10 E2E + 3 backup shell tests chạy được trên infra thật; nhưng CI coverage gate lỏng lẻo (`45–55%`), không gate các service chính (`http.ts`, `payments.ts`, `operations.ts`, `outbox.ts`, `realtime.ts`), bằng 0 load/chaos/concurrency-deadlock stress tests. |

---

## 3. Hiện trạng đã hoàn thành tốt (`DONE`) — Không cần đập đi làm lại

Các hạng mục sau đã được kiểm chứng trực tiếp qua code và migration, đạt tiêu chuẩn kỹ thuật tốt và chỉ cần bảo toàn hoặc mở rộng tương thích:

1. **Multi-tenant Composite Foreign Keys & DB Ledger Immutability (`DONE`)**
   - Mọi bảng nghiệp vụ chính mang `tenantId`, `storeId` và composite unique/FK trỏ về `Store(tenantId, id)` trong [`prisma/schema.prisma`](../../prisma/schema.prisma).
   - PostgreSQL CHECK constraints & triggers trong [`prisma/migrations/202610210002_invariants/migration.sql`](../../prisma/migrations/202610210002_invariants/migration.sql), [`202610230002_cash_shift_state_machine/migration.sql`](../../prisma/migrations/202610230002_cash_shift_state_machine/migration.sql), [`202610240001_multi_method_payments/migration.sql`](../../prisma/migrations/202610240001_multi_method_payments/migration.sql) khóa cứng state machine của `Balance`, `Payment`, `CashShift`, `Refund`, `RefundDecision`, `Movement`, `Audit`, `BillSplit`.
2. **Pure Domain Math & State Machine (`DONE`)**
   - [`apps/api/src/domain.ts`](../../apps/api/src/domain.ts) & [`apps/api/src/catalog-domain.ts`](../../apps/api/src/catalog-domain.ts): `BigInt` cho `allocateVnd` / `convertUnit`, `Decimal` `.000` cho `composeRecipe`, scrypt `N=16384,r=8,p=1`, state transitions thuần không side-effect.
3. **Global Sanitized Exception Filter & Path Redaction (`DONE`)**
   - [`apps/api/src/errors.ts`](../../apps/api/src/errors.ts#L57-L146): Mapping lỗi Prisma (`P2025`, `P2002`, `P2034`, `P10*`, `P2024`), NestJS `HttpException`, JSON `SyntaxError`, `entity.too.large` về envelope `{ code, correlationId }` sạch, không lộ stack/SQL/credential; [`accessLogPath`](../../apps/api/src/deployment-security.ts#L30-L35) redact capability tokens trên URL public.
4. **Fail-Closed Startup Security Guard & Secret Loading (`DONE`)**
   - [`apps/api/src/deployment-security.ts`](../../apps/api/src/deployment-security.ts#L4-L28), [`deploy/load-secrets.cjs`](../../deploy/load-secrets.cjs), [`deploy/postgres-init.sh`](../../deploy/postgres-init.sh), [`deploy/redis-start.sh`](../../deploy/redis-start.sh): Tách role `omnihub_owner` / `omnihub_app` / `omnihub_backup`, Redis ACL least-privilege, Docker non-root + `read_only` + `cap_drop: ALL`.
5. **Outbox Time Budget & Concurrency Locking (`DONE` trong M1)**
   - [`apps/api/src/outbox.ts`](../../apps/api/src/outbox.ts#L63-L270): `FOR UPDATE SKIP LOCKED`, bounded batch budget `10s` nằm gọn trong transaction timeout `15s` với commit headroom `5s`, commit partial `deliveredAt` trước deadline.
6. **Atomic Redis Lua Rate Limiting Core (`DONE` phần lõi thuật toán)**
   - [`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts#L5-L26): Script Lua `INCR` + `PEXPIRE` + `PTTL` atomic trên một round-trip Redis và fail-closed 503 khi Redis down.

---

## 4. Chi tiết các phát hiện Audit (`PARTIAL` / `MISSING` / `RISK`)

---

### MIỀN A — Architecture & Modularity

#### Finding A-01 `[PARTIAL]` — Monolithic Controller & Thiếu NestJS Dependency Injection
1. **Vị trí:** [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L22-L316), [`apps/api/src/http-app.ts`](../../apps/api/src/http-app.ts#L27)
2. **Mô tả vấn đề:** `AppModule` chỉ khai báo `controllers: [ApiController]` (`http.ts#L315-L316`) với 0 `providers`. Các service (`Operations`, `CatalogOperations`, `CashShifts`, `Payments`, `QrOrdering`, `PilotAdmin`) bị khởi tạo bằng `new` tĩnh ở module scope (`http.ts#L22-L27`) gắn chặt singleton `db`. Controller `ApiController` chứa hơn 45 endpoints trên 260+ dòng, pha trộn transport parsing (`parse()`, `uuid()`, `context()`), authorization thủ công (`allowed()`), raw `db.$transaction` (`registerKitchenDevice` L108, `assignKitchenDevice` L193, `revokeKitchenDevice` L212), và read queries phức tạp (`listKitchenDevices` L160, `pilotReadiness` L171, `orders` L92, `report` L241).
3. **Tác động production:** Không thể tách unit/module tests bằng mock/DI container sạch; vi phạm Single Responsibility; thay đổi auth/device guard dễ bỏ sót endpoint mới (như đã xảy ra với sự không đồng nhất giữa `PilotAdmin` bypass `CommandBus` và `Operations`); khó áp dụng interceptors/guards/OpenAPI generation theo từng bounded context khi đội ngũ mở rộng.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Tách thành NestJS feature modules (`AuthModule`, `CatalogModule`, `OrdersModule`, `KitchenModule`, `PaymentsModule`, `CashShiftsModule`, `QrOrderingModule`, `AdminModule`, `HealthModule`). Inject `PrismaClient`, `Logger`, `Config`, và domain services qua NestJS DI (`PrismaModule`). Chuyển inline queries/transactions từ controller (`http.ts#L108-L218`, `#L229-L252`) vào Service classes tương ứng (`KitchenService`, `ReportingService`, `AdminService`), dùng NestJS `Guards` (`SessionGuard`, `PermissionGuard`, `KitchenDeviceGuard`) và `ZodValidationPipe`.
6. **Acceptance Criteria:**
   - Không còn service nào được `new` tĩnh ở top-level file controller.
   - Không có controller nào gọi trực tiếp `db.*` hoặc `db.$transaction(...)`.
   - `AppModule` import các feature modules rõ ràng; toàn bộ routes giữ nguyên behavior và HTTP contract cũ (hoặc qua version prefix ở Finding E-01).
7. **Tests cần có:** Integration tests kiểm tra NestJS DI bootstrap thành công với `Test.createTestingModule`, xác nhận toàn bộ guards (`401`/`403`) và endpoints cũ hoạt động không regression.

#### Finding A-02 `[RISK]` — Thiếu tầng Service cho Kitchen Device lifecycle & Audit ngoài `CommandBus`
1. **Vị trí:** [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L35-L37), [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L105-L220)
2. **Mô tả vấn đề:** `auditKitchenDevice` (`http.ts#L35-L37`) ghi `Audit` bằng random UUID commandKey (`kitchen-device:${action}:${randomUUID()}`) **bên ngoài** transaction của nghiệp vụ (`syncKitchenCommands` L157), không dùng `CommandBus`, và `registerKitchenDevice` / `assignKitchenDevice` / `revokeKitchenDevice` (`L108-L218`) tự viết `db.$transaction` trong controller nhưng **không ghi bản ghi `Outbox`**, nên realtime clients hoặc các replica không nhận được sự kiện thu hồi/gán lại trạm.
3. **Tác động production:** Khi admin revoke một thiết bị bếp (`POST /admin/kitchen/devices/:id/revoke`), thiết bị đó tiếp tục nhận WebSocket events tối đa 30 giây (đến chu kỳ `revalidateRealtimeSockets`) hoặc khi client retry sync không có idempotency key thật sự sẽ tạo nhiều bản ghi audit trùng lặp.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Đưa toàn bộ Kitchen Device commands (`register`, `assign`, `revoke`, `sync`) vào `KitchenService extends CommandBus` (hoặc hỗ trợ `Idempotency-Key` chuẩn) và phát Outbox event `kitchen.device.changed` để WebSocket gateway ngắt kết nối device bị revoke ngay lập tức.
6. **Acceptance Criteria:**
   - `assignKitchenDevice` và `revokeKitchenDevice` chạy qua `CommandBus` với `Idempotency-Key`, ghi đồng bộ `Audit` + `Outbox` + `CommandReceipt` trong cùng transaction.
   - Không còn hàm `auditKitchenDevice` tự tạo `randomUUID()` ngoài transaction.
7. **Tests cần có:** Integration test chứng minh idempotent replay cho `revokeKitchenDevice` / `assignKitchenDevice` không tạo 2 Audit rows và đẩy event ra Outbox.

---

### MIỀN B — Authentication, Authorization & Multi-Tenancy

#### Finding B-01 `[RISK]` — Rate Limit Auth chỉ theo IP, thiếu Per-Account Lockout & Exponential Backoff
1. **Vị trí:** [`apps/api/src/main.ts`](../../apps/api/src/main.ts#L38), [`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts#L33-L34), [`apps/api/src/auth.ts`](../../apps/api/src/auth.ts#L23-L35)
2. **Mô tả vấn đề:** `/auth/login` hiện chỉ giới hạn `10 requests / 60s` trên **một địa chỉ IP** (`digest(address)` ở `rate-limit.ts#L34`), hoàn toàn không đếm số lần sai mật khẩu theo `(email, storeId)` hoặc toàn tài khoản `userId`. Ngược lại, một quán ăn F&B có nhiều nhân viên thu ngân/bếp/quản lý dùng chung **1 IP WAN (NAT)** có thể bị khóa chéo lẫn nhau chỉ vì một thiết bị nhập sai hoặc mở nhiều tab/session cùng lúc (`10 req/60s` trên 1 IP NAT). Đồng thời kẻ tấn công dùng distributed IPs/botnet có thể thử không giới hạn số lần trên 1 `email` mục tiêu.
3. **Tác động production:** Hai rủi ro đối nghịch cùng xảy ra: (a) Denial-of-Service đối với quán ăn thật đi qua chung NAT/4G router, (b) Credential stuffing / password spraying từ nhiều IP vào tài khoản `OWNER`/`MANAGER` mà hệ thống không khóa hay cảnh báo.
4. **Mức độ ưu tiên:** `P0`
5. **Đề xuất giải pháp:** Bổ sung dual-key rate limiting & account protection:
   - Redis rate limiter tách ngưỡng cao hơn cho IP hoặc kết hợp `(ip, normalizedEmail)` + khóa riêng cho `account:{emailHash}` (ví dụ: 5–10 lần sai liên tiếp -> cooldown tăng dần hoặc lockout tạm 15 phút, reset khi login thành công).
   - Bổ sung audit event `AUTH_LOGIN_FAILED` / `AUTH_ACCOUNT_LOCKED` (không log plaintext password/email raw nếu cần bảo mật PII, dùng userId/email hash).
6. **Acceptance Criteria:**
   - Brute-force một `email` từ 20 IP khác nhau vẫn bị chặn sau ngưỡng N lần sai (`429 ACCOUNT_TEMPORARILY_LOCKED` hoặc `RATE_LIMITED`).
   - Nhân viên khác cùng chung NAT IP đăng nhập đúng email khác không bị block bởi lỗi nhập sai của một máy khác (trong giới hạn bảo vệ IP chống flood đủ hợp lý).
7. **Tests cần có:** Redis integration test kiểm thử brute-force 1 email từ nhiều `X-Forwarded-For` bị chặn, và multi-user trên cùng IP không tự khóa oan tài khoản hợp lệ.

#### Finding B-02 `[MISSING]` — Thiếu Session Lifecycle Management (List/Revoke All, Store Switching, TTL Cleanup)
1. **Vị trí:** [`apps/api/src/auth.ts`](../../apps/api/src/auth.ts#L23-L35), [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L62-L72), [`prisma/schema.prisma`](../../prisma/schema.prisma#L45-L60)
2. **Mô tả vấn đề:** Hệ thống chỉ có `POST /auth/login` (8 tiếng cố định, không sliding refresh), `GET /auth/me`, và `POST /auth/logout` (chỉ xóa `session` cookie hiện tại). Thiếu hoàn toàn:
   - API thu hồi toàn bộ phiên đăng nhập của user (`POST /auth/logout-all` hoặc `DELETE /admin/users/:id/sessions` khi nhân viên nghỉ việc / mất máy POS).
   - API chuyển chi nhánh (`POST /auth/switch-store`) cho user/owner có nhiều `Membership` ở nhiều `Store` mà không phải nhập lại mật khẩu.
   - Cơ chế dọn dẹp (`DELETE FROM "Session" WHERE "expiresAt" < now()`) — bảng `Session` và `TableSession` phình to vô hạn theo thời gian.
3. **Tác động production:** Khi thu hồi quyền hoặc nghi lộ thiết bị, manager không có cách thu hồi mọi token đang hoạt động từ UI/API (trừ vô hiệu hóa user toàn bộ hoặc đợi 8h); bảng `Session` tích tụ rác làm chậm index lookup theo thời gian; multi-branch SaaS thiếu luồng switch store mượt mà.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Thêm endpoint `POST /auth/logout-all` (xóa mọi `Session` của `userId`) và `POST /admin/members/:userId/revoke-sessions` (chỉ `OWNER`/`MANAGER` trong phạm vi store/tenant).
   - Thêm endpoint `POST /auth/switch-store` kiểm tra `Membership` của `userId` tại `targetStoreId` thuộc cùng tenant hoặc user hợp lệ, tạo/cập nhật session và rotate token cookie mới.
   - Thêm scheduled cleanup task (worker cron nhẹ) xóa `Session` hết hạn và `TableSession` hết hạn/đóng quá N ngày.
6. **Acceptance Criteria:**
   - Sau `logout-all` hoặc `revoke-sessions`, mọi cookie token cũ trả `401 SESSION_EXPIRED`/`SESSION_REVOKED` ngay lập tức và WebSocket đóng kết nối ở lần revalidate kế tiếp (hoặc ngay lập tức nếu emit event).
   - Cleanup job xóa định kỳ các phiên hết hạn theo batch giới hạn (ví dụ `LIMIT 1000`) không gây lock bảng.
7. **Tests cần có:** Integration tests cho `logout-all`, `revoke-sessions`, `switch-store` (chặn cross-tenant switch), và batch session cleanup.

#### Finding B-03 `[RISK]` — `PilotAdmin` tạo/thu hồi/chấp nhận invitation có race TOCTOU & thiếu correlationId
1. **Vị trí:** [`apps/api/src/pilot-admin.ts`](../../apps/api/src/pilot-admin.ts#L16-L30), [`apps/api/src/pilot-admin.ts`](../../apps/api/src/pilot-admin.ts#L53-L71)
2. **Mô tả vấn đề:**
   - `createInvitation` kiểm tra `existingUser` và `pending` bằng query ngoài transaction (`L17-L20`), sau đó mới mở `Serializable` tx (`L22`) mà không kiểm tra lại bên trong tx và DB không có partial unique index cho pending invitations -> 2 requests đồng thời có thể tạo 2 invitation `PENDING` cùng email.
   - `acceptInvitation` (`L53-L71`) chạy ngoài `CommandBus`, truyền cứng `correlationId: ''` vào `Audit` (`L68`), và kiểm tra mật khẩu `existing` (`L59`) ngoài transaction trước khi khóa/claim invitation.
   - Rate limit cho `/public/invitations/:token/accept` hiện dùng chung `/public/` (`60 req/60s` ở `main.ts#L40`), hơi cao đối với endpoint có thao tác password verification + account creation (`scrypt` tốn CPU).
3. **Tác động production:** Kẻ tấn công hoặc client retry có thể tạo nhiều lời mời chồng chéo hoặc brute-force mật khẩu `existing` user qua invitation endpoint với ngưỡng 60 lần/phút (scrypt DoS CPU + đoán password tài khoản có sẵn); Audit trail mất `correlationId` không trace được HTTP request gây ra sự kiện nhận lời mời.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Thêm partial unique index PostgreSQL trên `StoreInvitation(tenantId, storeId, lower(email)) WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`.
   - Đưa toàn bộ check (`existingUser`, `membership`, `pending`) vào trong transaction hoặc `CommandBus`.
   - Truyền `correlationId` từ HTTP request vào `acceptInvitation`, và áp rate limit riêng cho `/public/invitations/` tương đương `/auth/login` (10 req/60s).
6. **Acceptance Criteria:**
   - Gửi song song 2 request `POST /admin/invitations` cùng email chỉ 1 thành công, request còn lại trả `409 INVITATION_ALREADY_PENDING`.
   - `Audit` row của `STORE_INVITATION_ACCEPTED` luôn có `correlationId` khớp `x-correlation-id` của HTTP response.
7. **Tests cần có:** Integration tests cho concurrent `createInvitation`, `acceptInvitation` correlationId propagation, và rate limit `/public/invitations/:token/accept`.

#### Finding B-04 `[RISK]` — `deployment-security.ts` từ chối mọi proxy CIDR khác `/32` và `/128`
1. **Vị trí:** [`apps/api/src/deployment-security.ts`](../../apps/api/src/deployment-security.ts#L12-L17)
2. **Mô tả vấn đề:** Kiểm tra `TRUSTED_PROXY_CIDRS` chỉ chấp nhận không có prefix hoặc prefix đúng bằng `32` (IPv4) / `128` (IPv6) (`Number(prefix) !== (family === 4 ? 32 : 128)`). Mọi subnet hợp lệ trong thực tế như AWS VPC ALB (`10.0.0.0/16`), Docker bridge (`172.29.87.0/24`), Kubernetes pod CIDR (`10.244.0.0/16`), hoặc Cloudflare IP ranges (`/20`, `/22`, `/32`) đều làm API crash khi boot trong `NODE_ENV=production` với `UNSAFE_DEPLOYMENT_TRUSTED_PROXY_CIDRS`.
3. **Tác động production:** Không thể deploy OMNIHUB phía sau cloud load balancer / reverse proxy autoscaling hoặc Kubernetes ingress dùng dải IP động theo subnet, trừ khi gắn cứng từng IP `/32` thủ công.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Cho phép dải prefix CIDR an toàn thay vì chỉ `/32` và `/128` (ví dụ từ `/8` đến `/32` cho IPv4 RFC1918/link-local hoặc allowlist rõ ràng, cấm `/0` rộng toàn Internet như `0.0.0.0/0` hoặc `::/0`), đồng thời giữ nguyên từ chối `trust proxy: true` không giới hạn.
6. **Acceptance Criteria:**
   - `TRUSTED_PROXY_CIDRS="172.29.87.0/24,10.0.0.0/16"` hợp lệ ở `NODE_ENV=production`.
   - `TRUSTED_PROXY_CIDRS="0.0.0.0/0"` hoặc chuỗi rác vẫn bị từ chối với `UNSAFE_DEPLOYMENT_TRUSTED_PROXY_CIDRS`.
7. **Tests cần có:** Unit tests trong `tests/unit/deployment-security.test.ts` cover valid subnets (`/24`, `/16`, `/64`), `/32`, và reject `/0` hoặc syntax sai.

---

### MIỀN C — Database & Data Integrity

#### Finding C-01 `[RISK]` — Thiếu Index cho truy vấn lịch sử Movement theo Store & Time-series
1. **Vị trí:** [`prisma/schema.prisma`](../../prisma/schema.prisma#L343), [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L238), [`apps/api/src/catalog-operations.ts`](../../apps/api/src/catalog-operations.ts#L285-L290)
2. **Mô tả vấn đề:** Model `Movement` hiện chỉ có `@@index([tenantId, storeId, ingredientId, createdAt])` (dòng 343) và `@@unique([tenantId, storeId, commandKey, itemId, ingredientId, kind])`. Không có index bắt đầu bằng `(tenantId, storeId, createdAt)` hay `(tenantId, storeId, kind, createdAt)`. Trong khi đó cả `GET /inventory/movements` (`http.ts#L238`) và `GET /admin/inventory/movements` (`catalog-operations.ts#L286-L289`) đều lọc theo `(tenantId, storeId)` và sắp xếp `ORDER BY "createdAt" DESC`.
3. **Tác động production:** Khi một cửa hàng tích lũy hàng trăm nghìn hoặc hàng triệu dòng `Movement`, PostgreSQL buộc phải đọc toàn bộ các dòng thuộc `(tenantId, storeId)` theo index đầu rồi sort trên disk/memory để lấy `ORDER BY createdAt DESC LIMIT 100`. Gây tăng CPU/IOPS PostgreSQL và latency endpoint inventory/admin tăng tuyến tính theo thời gian vận hành.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Tạo migration bổ sung `CREATE INDEX "Movement_tenantId_storeId_createdAt_idx" ON "Movement"("tenantId", "storeId", "createdAt" DESC);` (và cân nhắc index có `kind` hoặc `ingredientId` tùy filter phổ biến).
6. **Acceptance Criteria:**
   - `EXPLAIN ANALYZE` cho truy vấn `WHERE "tenantId" = ... AND "storeId" = ... ORDER BY "createdAt" DESC LIMIT 100` sử dụng Index Scan trên `Movement_tenantId_storeId_createdAt_idx` (không còn Sort node toàn phần).
7. **Tests cần có:** Migration check + integration test verify schema index và query plan hoặc functional pagination test trên `movements`.

#### Finding C-02 `[RISK]` — Kiểm tra trùng tên (`uniqueName`) bằng đọc toàn bộ bảng vào RAM + lỗ hổng race/soft-delete
1. **Vị trí:** [`apps/api/src/catalog-operations.ts`](../../apps/api/src/catalog-operations.ts#L9-L11), [`catalog-operations.ts`](../../apps/api/src/catalog-operations.ts#L21-L22), [`#L33-L34`](../../apps/api/src/catalog-operations.ts#L33-L34), [`#L53-L54`](../../apps/api/src/catalog-operations.ts#L53-L54), [`#L80`](../../apps/api/src/catalog-operations.ts#L80), [`#L147`](../../apps/api/src/catalog-operations.ts#L147), [`#L162`](../../apps/api/src/catalog-operations.ts#L162), [`#L211`](../../apps/api/src/catalog-operations.ts#L211), [`#L230`](../../apps/api/src/catalog-operations.ts#L230), [`#L246`](../../apps/api/src/catalog-operations.ts#L246)
2. **Mô tả vấn đề:** Mọi thao tác tạo/sửa `Category`, `Station`, `Ingredient`, `Product`, `ProductVariant`, `ModifierGroup`, `Modifier` đều `findMany` lấy hết danh sách `name` của tenant+store vào Node.js rồi chạy JS `localeCompare(..., { sensitivity: 'accent' })`. Ngoài chi phí memory/query O(N) mỗi lần lưu:
   - `createCategory` (`L21`) và `updateCategory` (`L33`) quên lọc `deletedAt: null` khi lấy `peers`, nên category đã bị archive/soft-delete vẫn chặn vĩnh viễn việc tạo lại tên đó! (Trong khi `saveStation` L53 và các entity khác có `deletedAt: null`).
   - Không có partial unique index trong PostgreSQL (`WHERE "deletedAt" IS NULL`), nên ngoài `Serializable` conflict thỉnh thoảng (nếu predicate lock phủ đúng hoặc lỡ đổi isolation level), tính duy nhất không được đảm bảo ở tầng DB.
3. **Tác động production:** (a) Admin archive một category rồi không bao giờ đặt lại được tên cũ; (b) Store nhiều SKU tải dư thừa toàn bộ tên danh mục/sản phẩm trong transaction khóa `Serializable`, làm tăng nguy cơ serialization failure (`P2034`) khi nhiều nhân viên chỉnh sửa catalog song song.
4. **Mức độ ưu tiên:** `P2`
5. **Đề xuất giải pháp:** Tạo PostgreSQL functional partial unique indexes (hoặc `citext` / `lower(trim(name))`) cho từng bảng catalog (`Category`, `Station`, `Ingredient`, `Product`, v.v.) với điều kiện `WHERE "deletedAt" IS NULL`, và dựa vào constraint DB (kèm check `deletedAt: null` nhất quán nếu giữ app-level check thân thiện). Lưu ý migration cần deduplicate/kiểm tra dữ liệu cũ trước khi tạo unique index.
6. **Acceptance Criteria:**
   - Có thể tạo lại `Category` trùng tên với một `Category` đã bị archive (`deletedAt IS NOT NULL`).
   - Không thể tồn tại 2 bản ghi active (`deletedAt IS NULL`) trùng tên phân biệt hoa/thường trong cùng scope ở cấp PostgreSQL.
7. **Tests cần có:** Integration tests: archive category -> tạo lại cùng tên thành công; tạo song song cùng tên khác case (`"Coffee"` vs `"coffee"`) -> một thành công, một trả `409`.

#### Finding C-03 `[RISK]` — Lock Acquisition Order không đồng nhất giữa các service tài chính (`Order`, `Payment`, `CashShift`, `Refund`)
1. **Vị trí:** [`apps/api/src/payments.ts`](../../apps/api/src/payments.ts#L33-L45), [`payments.ts`](../../apps/api/src/payments.ts#L67-L68), [`payments.ts`](../../apps/api/src/payments.ts#L118), [`payments.ts`](../../apps/api/src/payments.ts#L137-L144), [`apps/api/src/operations.ts`](../../apps/api/src/operations.ts#L93-L100), [`operations.ts`](../../apps/api/src/operations.ts#L120-L163), [`apps/api/src/cash-shifts.ts`](../../apps/api/src/cash-shifts.ts#L45-L71)
2. **Mô tả vấn đề:** Các transaction giữ nhiều row locks theo thứ tự khác nhau:
   - `Payments.record` (`payments.ts#L33,44`): lock `Order` -> `CashShift`.
   - `Operations.cash` (`operations.ts#L150-L160`): đọc `Order` -> `Payment` -> lock `CashShift` -> update `Order` (lấy `Order` share/SIREAD trước hoặc update cuối sau khi giữ lock `CashShift`).
   - `Payments.verify` / `failPending` (`payments.ts#L67-L68, #84-85`): lock `Order` -> `Payment`.
   - `Payments.decideRefund` (`payments.ts#L137-L144, #L160`): lock `Refund` -> `Payment` -> `CashShift` -> update `Order`.
   - `CashShifts.close` / `move` (`cash-shifts.ts#L45,71`): lock `CashShift` rồi đọc/aggregate `Payment`.
3. **Tác động production:** Dưới tải cao đồng thời (ví dụ: thu ngân vừa đóng ca / duyệt hoàn tiền vừa nhận thanh toán tiền mặt hoặc xác nhận chuyển khoản trên cùng `CashShift`/`Order`), thứ tự khóa ngược chiều (`Order -> CashShift` vs `CashShift -> Payment/Order` hoặc `Payment -> CashShift` vs `Order -> CashShift`) có thể gây deadlock PostgreSQL (`40P01`) và serialization retries (`40001`), làm văng `CONCURRENT_CHANGE_RETRY_SAME_KEY` sau khi retry hoặc làm chậm các giao dịch POS giờ cao điểm.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Chuẩn hóa **Canonical Lock Ordering** toàn hệ thống (ví dụ quy ước bất biến: `Store/CashShift` -> `Order` -> `OrderItem/Balance (sorted by id)` -> `Payment` -> `Refund`) hoặc dùng explicit `SELECT ... FOR UPDATE` đúng thứ tự ngay đầu transaction ở các luồng chạm nhiều bảng (`decideRefund`, `cash`, `record`, `close`), kết hợp stress test concurrency để chứng minh không phát sinh deadlock vòng.
6. **Acceptance Criteria:**
   - Tài liệu + code tuân thủ một thứ tự khóa duy nhất across `Operations`, `Payments`, `CashShifts`.
   - Chạy đồng thời `record CASH payment`, `decideRefund CASH`, `close shift`, `verify BANK_TRANSFER` không phát sinh deadlock `40P01`.
7. **Tests cần có:** Integration concurrency tests chạy `Promise.all` đồng thời các luồng trên cùng store/shift/order và kiểm tra zero `40P01` deadlocks + bảo toàn invariant số dư.

#### Finding C-04 `[RISK]` — `decideRefund` buộc Manager duyệt hoàn tiền mặt phải đang tự mở ca `CashShift` của chính mình
1. **Vị trí:** [`apps/api/src/payments.ts`](../../apps/api/src/payments.ts#L143-L148), [`apps/api/src/payments.ts`](../../apps/api/src/payments.ts#L156)
2. **Mô tả vấn đề:** Khi duyệt hoàn tiền phương thức `CASH` (`decideRefund`), query kiểm tra `"cashierId" = current.userId AND status = 'OPEN' FOR UPDATE` (L144). Nghĩa là chính người Manager bấm duyệt (`current.userId`) bắt buộc phải đang có ca thu ngân mở đứng tên **chính mình**; nếu tiền mặt hoàn từ két/ca của nhân viên thu ngân (`payment.cashShiftId` hoặc ca đang mở trên quầy), Manager không thể duyệt hoàn tiền mặt nếu Manager không tự mở một ca thu ngân riêng! Hơn nữa `CashMovement` được tạo với `commandKey: `${key}:cash`` thay vì liên kết rõ ràng vào ca gốc hay ca được chỉ định.
3. **Tác động production:** Đứt gãy quy trình vận hành nhà hàng thực tế: cashier mở ca thu tiền, khách yêu cầu hoàn tiền mặt, manager duyệt hoàn tiền nhưng bị chặn `OPEN_CASH_SHIFT_REQUIRED_FOR_CASH_REFUND` hoặc buộc manager mở ca giả dẫn tới sai lệch đối soát tiền mặt cuối ca của cashier thật (tiền trong két của cashier bị trừ thực tế nhưng sổ sách ghi trừ vào ca riêng của manager!).
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Cho phép hoặc liên kết `refund` với `cashShift` mục tiêu (hoặc ca `OPEN` hiện tại của thu ngân / truyền `shiftId` rõ ràng có quyền admin/cashApprove, fallback nếu `payment.cashShiftId` đang `OPEN` hoặc chọn `shiftId` hợp lệ trong store và ghi nhận rõ `actorId = manager`, `shift.cashierId` vẫn được đối soát đúng). Nếu chính sách nghiệp vụ cố tình yêu cầu ca riêng của manager, cần explicit contract rõ ràng và document/validate ở API input.
6. **Acceptance Criteria:**
   - Manager có thể duyệt hoàn tiền mặt cho ca thu ngân đang mở (khi chỉ định hoặc xác định rõ ca nguồn chi tiền) mà không bị buộc phải mở ca thu ngân cá nhân giả, và `CashShift.expectedAmount` phản ánh chính xác két đã chi tiền.
7. **Tests cần có:** Integration tests cho manager duyệt hoàn tiền mặt trên ca đang mở của cashier và case ca đã đóng.

#### Finding C-05 `[MISSING]` — Thiếu cơ chế retention / archival / cleanup cho các bảng tăng trưởng vô hạn (`Audit`, `CommandReceipt`, `Outbox`, `Session`, `TableSession`) & thiếu cấu hình `Database` pool / timeout
1. **Vị trí:** [`prisma/schema.prisma`](../../prisma/schema.prisma#L45-L60), [`#L228-L243`](../../prisma/schema.prisma#L228-L243), [`#L524-L565`](../../prisma/schema.prisma#L524-L565), [`apps/api/src/database.ts`](../../apps/api/src/database.ts#L1-L5)
2. **Mô tả vấn đề:**
   - `CommandReceipt` giữ vĩnh viễn toàn bộ idempotency payloads/responses không có TTL pruning; `Outbox` giữ vĩnh viễn các dòng đã `deliveredAt IS NOT NULL`; `Session` và `TableSession` không có job dọn dẹp các phiên đã hết hạn.
   - [`apps/api/src/database.ts`](../../apps/api/src/database.ts#L5) khởi tạo `new PrismaClient()` mặc định không cấu hình connection pool fallback, không log slow queries (`$on('query')` / threshold), và không cài đặt `statement_timeout` hoặc `idle_in_transaction_session_timeout` cho role ứng dụng `omnihub_app` trong [`deploy/postgres-init.sh`](../../deploy/postgres-init.sh#L11-L20).
3. **Tác động production:** Sau vài tháng chạy production, table bloat trên `Outbox` / `CommandReceipt` / `Session` làm tăng dung lượng backup `pg_dump` và thời gian vacuum; một query treo hoặc giao dịch lỗi có thể giữ connection / lock vô thời hạn nếu không có `statement_timeout` & `idle_in_transaction_session_timeout`.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Trong `deploy/postgres-init.sh` (và migration/runbook), cấu hình `ALTER ROLE omnihub_app SET statement_timeout = '15s'; ALTER ROLE omnihub_app SET idle_in_transaction_session_timeout = '20s'; ALTER ROLE omnihub_app SET lock_timeout = '5s';`.
   - Bổ sung maintenance worker/job dọn theo batch (có retention window rõ ràng, ví dụ `Outbox` delivered > 7 ngày, `Session`/`TableSession` expired > 7 ngày, `CommandReceipt` > 30 ngày — lưu ý giữ nguyên `Audit`/`Movement`/`Payment` theo yêu cầu kế toán hoặc partition theo tháng sau này).
6. **Acceptance Criteria:**
   - Role `omnihub_app` có timeout bảo vệ DB khỏi query treo và idle-in-transaction lock leaks.
   - Cleanup job xóa được dữ liệu hết hạn theo batch giới hạn kích thước mà không block traffic POS.
7. **Tests cần có:** Integration tests kiểm tra cleanup job chỉ xóa records quá hạn retention, không chạm records còn hạn hoặc bảng immutable (`Audit`, `Movement`, `Payment`).

#### Finding C-06 `[PARTIAL]` — Store timezone khóa cứng `'Asia/Ho_Chi_Minh'`
1. **Vị trí:** [`apps/api/src/domain.ts`](../../apps/api/src/domain.ts#L56), [`prisma/migrations/202610210002_invariants/migration.sql`](../../prisma/migrations/202610210002_invariants/migration.sql#L10)
2. **Mô tả vấn đề:** `businessDate()` ném lỗi nếu `timezone !== 'Asia/Ho_Chi_Minh'` và DB constraint `store_business_clock` khóa cứng `timezone = 'Asia/Ho_Chi_Minh'`.
3. **Tác động production:** Hoàn toàn ổn cho pilot Việt Nam hiện tại, nhưng sẽ chặn mở rộng thị trường quốc tế nếu không mở rộng `Intl.DateTimeFormat` theo danh sách IANA timezone hợp lệ.
4. **Mức độ ưu tiên:** `P3`
5. **Đề xuất giải pháp:** Ghi nhận là hạn chế có chủ đích ở giai đoạn Việt Nam; khi mở rộng đa quốc gia ở milestone sau, chuyển sang hỗ trợ IANA timezones thông qua `Intl.DateTimeFormat` với mapping offset chuẩn và cập nhật constraint DB.
6. **Acceptance Criteria:** (Khi kích hoạt đa vùng) hỗ trợ ít nhất các IANA timezones chuẩn với test DST/non-DST chuyển ngày chính xác.
7. **Tests cần có:** Unit tests chuyển ngày `businessDate` với `dayStart` qua nhiều timezone.

---

### MIỀN D — Distributed Systems, Concurrency & Reliability

#### Finding D-01 `[MISSING]` — Socket.IO thiếu `@socket.io/redis-adapter`, nuốt lỗi Redis subscriber, và không sync revoke tức thời giữa replicas
1. **Vị trí:** [`apps/api/src/realtime.ts`](../../apps/api/src/realtime.ts#L288-L380)
2. **Mô tả vấn đề:**
   - `attachRealtime` (`realtime.ts#L289-L292`) khởi tạo Socket.IO `Server` mặc định (in-memory adapter), chỉ dùng một `Redis` subscriber tự viết lắng nghe kênh `omnihub.events` (`#L349-L365`). Dù mỗi API replica đều nhận message Pub/Sub để emit về socket local của mình, việc thiếu `@socket.io/redis-adapter` (hoặc HTTP sticky sessions ở proxy/LB) làm **HTTP long-polling handshake của Socket.IO thất bại (`400 Session ID unknown`)** khi request polling đi qua nhiều API replicas qua load balancer không sticky.
   - `subscriber.on('error', () => {})` (`L350-L352`) và `catch` tại `L362-L364` nuốt sạch mọi lỗi Redis disconnect hoặc lỗi DB trong `broadcastOperationalEvent` mà **không log bất kỳ cảnh báo nào**.
   - Ngoài ra, kiểm tra `ready()` ở [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L51-L55) chỉ kiểm tra `limiterRedis.ping()` mà không kiểm tra trạng thái kết nối của `realtime` Redis subscriber (`subscriber.status === 'ready'`).
3. **Tác động production:** Deploy >= 2 API instances phía sau LB (K8s Service / ALB / multi-upstream Caddy) khiến client kết nối Socket.IO fallback polling rớt liên tục; nếu Redis subscriber đứt âm thầm nhưng `limiterRedis` sống (hoặc reconnect chậm), API vẫn báo `/ready` 200 trong khi realtime bị mù sự kiện mà không có log nào trong stderr/stdout.
4. **Mức độ ưu tiên:** `P0`
5. **Đề xuất giải pháp:**
   - Cấu hình `@socket.io/redis-adapter` (với pub/sub Redis clients có `enableOfflineQueue: false` / ACL phù hợp, hoặc explicit sticky-session documentation + WebSocket-only option nếu giữ adapter nhẹ, ưu tiên `@socket.io/redis-adapter` để chuẩn multi-replica).
   - Bổ sung structured logging (`REDIS_REALTIME_UNAVAILABLE`, `REALTIME_BROADCAST_FAILED`) không nuốt lỗi âm thầm, và đưa health state của realtime subscriber vào `/ready` hoặc `/metrics`.
   - Khi thu hồi `Session` hoặc `KitchenDevice`, phát event Outbox tương ứng (`session.revoked` / `kitchen.device.changed`) để mọi replica ngắt socket bị thu hồi ngay lập tức thay vì chờ 30s.
6. **Acceptance Criteria:**
   - 2 API replicas đứng sau round-robin proxy phục vụ Socket.IO polling + WebSocket nâng cấp không lỗi `Session ID unknown`, nhận event từ Outbox worker đầy đủ.
   - Mất kết nối Redis subscriber ghi log JSON `warn`/`error` có cấu trúc và phản ánh vào health/readiness check.
7. **Tests cần có:** Redis + multi-replica API integration test kiểm chứng Socket.IO client kết nối qua replica A vẫn nhận được broadcast/session invalidation hoặc handshake thành công qua nhiều replicas.

#### Finding D-02 `[RISK]` — Outbox `quarantinedIds` chỉ nằm trên RAM (`Set` max 1000) và `worker.ts` bật `enableOfflineQueue` ngầm
1. **Vị trí:** [`apps/api/src/outbox.ts`](../../apps/api/src/outbox.ts#L14), [`outbox.ts`](../../apps/api/src/outbox.ts#L311), [`apps/api/src/worker.ts`](../../apps/api/src/worker.ts#L9-L10)
2. **Mô tả vấn đề:**
   - Khi phát hiện bản ghi Outbox lỗi schema (`!parsed.success` / invalid payload), worker thêm `row.id` vào `quarantinedIds` trên RAM (`outbox.ts#L311`, giới hạn `MAX_QUARANTINE_IDS = 1_000` tại `#L14`). Không có cột `attempts`, `lastError`, hay `quarantinedAt` trong bảng `Outbox` (`prisma/schema.prisma#L552-L565`). Mỗi khi worker container restart/deploy, toàn bộ poison messages chưa có `deliveredAt` lại được query và xử lý lại từ đầu; nếu vượt 1.000 poison rows, các dòng cũ tiếp tục lặp lại vô tận.
   - Ở [`apps/api/src/worker.ts`](../../apps/api/src/worker.ts#L9), `new Redis(REDIS_URL, { maxRetriesPerRequest: 1 })` không đặt `enableOfflineQueue: false` (khác với `limiterRedis` ở `main.ts#L20`) và `redis.on('error', () => undefined)` (`L10`) nuốt mọi lỗi kết nối Redis ngoài vòng batch.
3. **Tác động production:** Một hoặc nhiều poison event (ví dụ do migration/contract mismatch hoặc schema mới chưa đồng bộ) không được đưa vào Dead-Letter state bền vững trên DB -> gây ồn cảnh báo và lãng phí DB/worker cycles sau mỗi lần restart; khi Redis mất kết nối, ioredis offline queue có thể tích tụ commands chờ trong RAM thay vì fail-fast vào cơ chế backoff của `outbox.ts`.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Thêm các cột bền vững vào bảng `Outbox`: `attempts INT DEFAULT 0`, `lastError TEXT`, `nextAttemptAt TIMESTAMPTZ`, `deadLetteredAt TIMESTAMPTZ` (và cập nhật index `WHERE "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL`). Khi event malformed hoặc vượt ngưỡng retry tối đa (chỉ đối với lỗi permanent/contract, còn Redis outage vẫn backoff retry bình thường), đánh dấu `deadLetteredAt` + log cảnh báo `OUTBOX_DEAD_LETTERED`.
   - Thêm `enableOfflineQueue: false` cho Redis client trong `worker.ts` và log có kiểm soát sự kiện `ready`/`error` tương tự `main.ts`.
6. **Acceptance Criteria:**
   - Poison event (invalid contract) bị đẩy vào `deadLetteredAt` trên DB sau 1 lần phát hiện, không còn bị worker pick lại sau khi restart process.
   - Worker ngắt Redis fail-fast vào backoff loop mà không queue commands vô hạn trên RAM.
7. **Tests cần có:** Integration tests: (1) poison Outbox row chuyển `deadLetteredAt != null` và worker restart không xử lý lại; (2) worker offline Redis queue disabled fail-fast vào backoff.

#### Finding D-03 `[RISK]` — `CommandBus` retry cả lỗi `P2002`, không có Jitter, và có thể giữ HTTP request tới ~80 giây
1. **Vị trí:** [`apps/api/src/commands.ts`](../../apps/api/src/commands.ts#L15-L43), [`commands.ts`](../../apps/api/src/commands.ts#L46-L74)
2. **Mô tả vấn đề:**
   - Cả `command` (`#L35`) và `publicCommand` (`#L66`) retry tối đa 4 lần cho `P2034` (serialization failure), `P2010` (`40001`, `40P01`), **và cả `P2002` (Unique constraint violation)** với linear backoff cố định `20 * (attempt + 1)` ms (`#L37`, `#L68`) — **không có random jitter**.
   - Nếu `P2002` xảy ra do vi phạm unique constraint nghiệp vụ thật (ví dụ `CashRegister.name` trùng, `StockReceipt.reference` trùng, `RestaurantTable.name` trùng, hoặc `externalReference` trùng trên luồng khác chưa check), hệ thống chạy lại toàn bộ `Serializable` transaction 4 lần vô ích trước khi ném `409 CONCURRENT_CHANGE_RETRY_SAME_KEY` thay vì phân biệt `P2002` là duplicate resource vs `CommandReceipt` race!
   - Hơn nữa `publicCommand` (`#L65-L66`) thiếu hoàn toàn check `externalreference` và dùng non-canonical `JSON.stringify({ actor, operation, payload })` (`#L15`, `#L48`) cho idempotency hash (dù thứ tự key object có thể khác nhau tùy caller ngoài Zod).
   - Mỗi lần thử lại có `maxWait: 5000, timeout: 15000` (tối đa 20s × 4 = ~80s trên 1 HTTP connection).
3. **Tác động production:** (a) Lỗi trùng mã phiếu nhập kho/tên bàn không trả code nghiệp vụ rõ ràng mà retry 4 lần gây lãng phí DB locks rồi trả `CONCURRENT_CHANGE_RETRY_SAME_KEY`; (b) Khi xảy ra contention cao (`P2034`), các request retry đồng bộ không có jitter dễ tạo thundering herd vào PostgreSQL và giữ HTTP worker socket quá lâu.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Phân biệt `P2002`: chỉ retry khi target là `CommandReceipt` key race; mọi `P2002` trên bảng nghiệp vụ (`CashRegister`, `StockReceipt`, `RestaurantTable`, `Payment`, v.v.) map ngay thành `409 Conflict` nghiệp vụ rõ ràng không retry.
   - Thêm full/decorrelated jitter cho retry (`P2034` / `40001` / `40P01`), giữ tổng budget retry hợp lý (ví dụ total budget <= 15s–20s thay vì 80s).
   - Dùng canonical JSON serialization (sort object keys đệ quy) khi tính `hash` idempotency.
6. **Acceptance Criteria:**
   - Trùng `StockReceipt.reference` hoặc `CashRegister.name` thất bại ngay ở attempt 1 với code `409` phù hợp, không chạy lại transaction 4 lần.
   - Payload giống hệt nhau nhưng khác thứ tự key JSON vẫn cho cùng `hash` khi replay `Idempotency-Key`.
   - `P2034` retry có jitter và tôn trọng tổng thời gian deadline.
7. **Tests cần có:** Unit + integration tests kiểm chứng canonical hash, no-retry on business `P2002`, và jittered retry + overall deadline cho `P2034`.

#### Finding D-04 `[RISK]` — `QrOrdering.createTable` & `regenerate` tự phá cơ chế Idempotent Retry (`409 QR_CREATED_RETRY_WITH_NEW_KEY`)
1. **Vị trí:** [`apps/api/src/qr-ordering.ts`](../../apps/api/src/qr-ordering.ts#L20-L28), [`qr-ordering.ts`](../../apps/api/src/qr-ordering.ts#L40-L51)
2. **Mô tả vấn đề:** `createTable` và `regenerate` tạo `credential = token()` bên ngoài `this.command(...)` và gán biến closure `exposedToken = credential` bên trong callback `work` (`L24, L47`). Nếu request bị rớt mạng ở lượt response rồi client/POS retry đúng chuẩn với cùng `Idempotency-Key`, `CommandBus` trả về `receipt.response` mà không chạy `work` -> `exposedToken === ''` -> API ném **`409 QR_CREATED_RETRY_WITH_NEW_KEY` / `QR_ROTATED_RETRY_WITH_NEW_KEY`**! Điều này làm hỏng hợp đồng `Idempotency-Key` và khiến client tạo bàn bị thừa bàn rác hoặc phải quay vòng QR.
3. **Tác động production:** Mạng Wi-Fi quán ăn chập chờn khiến client retry tạo bàn hoặc rotate QR bị fail 409; retry với key mới tạo ra bản ghi bàn trùng hoặc xoay mất token vừa in trên UI.
4. **Mức độ ưu tiên:** `P2`
5. **Đề xuất giải pháp:** Có thể giữ nguyên nguyên tắc không lưu plaintext `qrToken` trong `Audit`/`CommandReceipt` nếu muốn bảo mật tuyệt đối, **NHƯNG** nếu server không lưu token thì giải pháp kiến trúc đúng là: (a) Cho phép client sinh hoặc derive / encrypted-envelope tạm thời hoặc (b) Trong `CommandReceipt` mã hóa symmetric (AES-256-GCM bằng key riêng ngắn hạn hoặc trả về `tableId`/`version` kèm hướng dẫn rõ trên contract), hoặc dùng `QR_TOKEN_SECRET` để mã hóa có xác thực (authenticated encryption với TTL ngắn) `token` trong `CommandReceipt.response` (xóa sau TTL cleanup) để replay cùng `Idempotency-Key` trong cửa sổ retry trả lại chính xác response ban đầu một cách an toàn.
6. **Acceptance Criteria:**
   - Gửi 2 lần `POST /admin/tables` hoặc `POST /admin/tables/:id/regenerate-qr` với cùng `Idempotency-Key` và payload nhận lại cùng `{ id, version, token }` hợp lệ, không sinh lỗi `409` và không tạo 2 bàn.
7. **Tests cần có:** Integration test retry `createTable` và `regenerate` cùng `Idempotency-Key` nhận lại đúng `token` hoạt động được ở `/public/qr/:token/menu`.

---

### MIỀN E — API Design & Runtime Reliability

#### Finding E-01 `[MISSING]` — Thiếu API Versioning, Endpoint trùng lặp & Unbounded List Endpoints
1. **Vị trí:** [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L48), [`http.ts`](../../apps/api/src/http.ts#L96), [`http.ts`](../../apps/api/src/http.ts#L162), [`http.ts`](../../apps/api/src/http.ts#L229-L239), [`http.ts`](../../apps/api/src/http.ts#L266), [`http.ts`](../../apps/api/src/http.ts#L288-L296), [`apps/api/src/cash-shifts.ts`](../../apps/api/src/cash-shifts.ts#L21), [`apps/api/src/catalog-operations.ts`](../../apps/api/src/catalog-operations.ts#L139-L142), [`#L285-L290`](../../apps/api/src/catalog-operations.ts#L285-L290)
2. **Mô tả vấn đề:**
   - **Không có API versioning:** Tất cả routes mount trực tiếp ở root (`@Controller()`, không có `/api/v1` hay `/v1`).
   - **Endpoint trùng lặp / hành vi khác nhau:** `GET /inventory/movements` (`http.ts#L235-L239`) trả mảng cố định `take: 200` không phân trang, trong khi `GET /admin/inventory/movements` (`http.ts#L312` -> `catalog.movements`) trả `{ rows, total, page, pageSize, pages }` có filter/pagination.
   - **Truy vấn không giới hạn (unbounded) hoặc fix cứng `take` không phân trang:** `GET /catalog`, `GET /inventory` (`#L232`), `GET /admin/tables` (`qr-ordering.ts#L17` include nested sessions + counts), `GET /admin/stations` (`#L50`), `GET /admin/ingredients`, `GET /public/qr/:token/menu` (`qr-ordering.ts#L79`) load toàn bộ dữ liệu + nested relations trong 1 request; `GET /orders` fix cứng `take: 100` kèm toàn bộ `items, tickets, payments, refunds, billSplits` (`http.ts#L96`); `GET /cash/shifts` fix cứng `take: 100` kèm toàn bộ nested `movements` và `payments` (`cash-shifts.ts#L21`) — nếu 1 ca có 2.000 payments thì 100 ca trả về ~200.000 rows trong 1 payload JSON!
   - **Deep offset pagination:** `listProducts` và `movements` (`catalog-operations.ts#L140, #288`) dùng `skip: (page - 1) * pageSize` không giới hạn page thấp hoặc chuyển keyset cursor cho ledger lớn.
3. **Tác động production:** Cửa hàng hoạt động đông hoặc chuỗi có menu lớn sẽ gặp payload JSON hàng chục MB (`GET /cash/shifts`, `GET /orders`, `GET /public/qr/:token/menu`), chạm OOM / timeout / chậm trên mobile POS yếu mạng; đồng thời không có `/v1` khiến mọi breaking contract change về sau khó hỗ trợ backward-compatible.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Thêm version prefix chuẩn (`/v1` hoặc global prefix với dual-mount / deprecation window cho frontend M1 nếu cần chuyển tiếp an toàn).
   - Bổ sung pagination (`cursor` cho `orders`, `movements`, `invitations`; tách chi tiết movements/payments của `cash/shifts` khỏi danh sách summary `GET /cash/shifts` hoặc cap + endpoint `/cash/shifts/:id`).
   - Thống nhất `GET /inventory/movements` và `/admin/inventory/movements` dùng chung một service pagination chuẩn.
6. **Acceptance Criteria:**
   - `GET /cash/shifts` list không trả unbounded nested `payments`/`movements` của toàn bộ 100 ca.
   - `GET /orders`, `GET /inventory`, `GET /inventory/movements`, `GET /admin/invitations` hỗ trợ pagination/filtering có giới hạn `limit` tối đa (e.g. `<= 100`).
7. **Tests cần có:** Integration tests kiểm tra pagination (`cursor`/`pageSize`), cap tối đa, và response shape của các list endpoints.

#### Finding E-02 `[RISK]` — Thiếu HTTP Server Timeouts, Explicit Payload Size Guard & Global Origin Gate xung đột với `/webhooks/*`
1. **Vị trí:** [`apps/api/src/main.ts`](../../apps/api/src/main.ts#L41-L44), [`apps/api/src/http-app.ts`](../../apps/api/src/http-app.ts#L27-L66), [`apps/api/src/http.ts`](../../apps/api/src/http.ts#L267-L270)
2. **Mô tả vấn đề:**
   - [`main.ts`](../../apps/api/src/main.ts#L44) gọi `app.listen(...)` mà không cấu hình Node `http.Server` timeouts (`requestTimeout`, `headersTimeout`, `keepAliveTimeout` — lưu ý Caddy/ALB keep-alive races cần `keepAliveTimeout > proxy keepalive` hoặc cấu hình rõ ràng), cũng không đặt explicit Express JSON body limit trong `http-app.ts` (hiện phụ thuộc default ngầm của `body-parser` NestJS).
   - [`http-app.ts#L60-L64`](../../apps/api/src/http-app.ts#L60-L64) chặn toàn bộ non-GET/HEAD/OPTIONS nếu `req.get('origin') !== origin` — bao gồm cả `/webhooks/*` (dù `main.ts#L41` đã gắn sẵn rate limiter riêng cho `/webhooks/`). Khi tích hợp payment gateway thật (VNPay/MoMo/PayOS/Stripe/etc.), webhook server-to-server **không gửi header `Origin`** nên sẽ bị `403 ORIGIN_DENIED` trừ khi có bypass riêng kèm HMAC/signature + replay verification.
   - `GET /admin/tables/qr-code` (`http.ts#L269`) vẫn cho fallback đọc `?token=` từ query string (`req.get('X-QR-Token') ?? token`), làm tăng nguy cơ lộ QR capability secret vào browser history / analytics / proxy nếu bật log sau này (ngay cả khi Caddyfile đang tắt access log).
3. **Tác động production:** Slowloris / slow-body client có thể giữ kết nối API; giữ nguyên Origin gate sẽ chặn toàn bộ payment webhook khi mở cổng thanh toán; query `?token=` trái chuẩn security-by-design của chính codebase.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Cấu hình tường minh `server.requestTimeout = 30_000`, `server.headersTimeout = 10_000`, `server.keepAliveTimeout = 65_000`, và explicit `bodyParser` limit (e.g., `256kb` trừ route sync/upload riêng).
   - Tách riêng CSRF Origin middleware khỏi route group `/webhooks/*` **chỉ khi** route webhook đó bắt buộc chạy qua HMAC signature + timestamp replay verification middleware fail-closed.
   - Loại bỏ fallback `?token=` trên `/admin/tables/qr-code` (hoặc deprecate có kiểm soát nếu frontend vẫn đang gửi header `X-QR-Token`).
6. **Acceptance Criteria:**
   - Server timeouts và JSON limit được test và kiểm chứng giá trị runtime.
   - `/webhooks/*` không dùng Origin browser check mà bắt buộc signature/HMAC check (hoặc trả `501/503` fail-closed khi provider chưa cấu hình).
7. **Tests cần có:** Unit/integration tests cho oversized payload (`413 PAYLOAD_TOO_LARGE`), invalid webhook without HMAC, và `X-QR-Token` header requirement.

---

### MIỀN F — Observability, Logging, Metrics & Error Handling

#### Finding F-01 `[MISSING]` — Hoàn toàn thiếu Metrics, Tracing & Saturation Telemetry (Prometheus / OpenTelemetry)
1. **Vị trí:** [`apps/api/src/main.ts`](../../apps/api/src/main.ts), [`apps/api/src/http-app.ts`](../../apps/api/src/http-app.ts#L53-L58), [`apps/api/src/outbox.ts`](../../apps/api/src/outbox.ts#L326-L380), [`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts#L41-L50)
2. **Mô tả vấn đề:** Toàn bộ backend không có một metric hay trace nào:
   - Không có endpoint `/metrics` (hoặc Prometheus exporter / OTel SDK).
   - Không đo HTTP latency histograms (p50/p95/p99), error rate theo route/code, rate-limit `429`/`503` counters (hiện [`rate-limit.ts#L41-L50`](../../apps/api/src/rate-limit.ts#L41-L50) trả `429`/`503` hoàn toàn **im lặng không log, không metric**).
   - Không đo Outbox lag (`oldestUndeliveredAgeSeconds`, `pendingCount`, `deadLetterCount`), `CommandBus` `P2034` retry frequency, số Socket.IO active connections, hoặc PostgreSQL pool exhaustion (`P2024`).
3. **Tác động production:** Vận hành mù mờ ("blind flying"): không biết API đang chậm vì DB pool nghẽn, transaction retry `P2034` tăng đột biến, brute-force đang đánh vào login (`429`), hay Outbox worker tụt hậu vài phút phía sau giao dịch POS trước khi khách phàn nàn màn hình bếp không cập nhật.
4. **Mức độ ưu tiên:** `P0`
5. **Đề xuất giải pháp:**
   - Tích hợp metrics registry (ví dụ `prom-client` nhẹ hoặc OpenTelemetry metrics) expose qua internal-only endpoint `/metrics` (chặn public proxy trên Caddyfile, chỉ cho scrape từ private network / loopback / bearer token).
   - Đo tối thiểu các Golden Signals & Domain metrics: `http_requests_total`, `http_request_duration_seconds`, `rate_limit_decisions_total{prefix,outcome}`, `command_bus_attempts_total{operation,outcome}`, `outbox_pending_count`, `outbox_oldest_pending_age_seconds`, `outbox_dead_letter_total`, `realtime_connected_sockets`.
   - Thêm log `warn` có cấu trúc (sampling/rate-aware nếu cần) khi `rate-limit` fail-closed `503` hoặc vượt ngưỡng `429`.
6. **Acceptance Criteria:**
   - `GET /metrics` (khi enable trên internal port/network) trả chuẩn Prometheus exposition format với toàn bộ metrics nêu trên cập nhật theo traffic thật.
   - Public reverse proxy (`deploy/Caddyfile`) không expose `/metrics` ra ngoài.
7. **Tests cần có:** Integration tests kiểm chứng `GET /metrics` ghi nhận tăng counters khi gửi HTTP request, trigger `429`, và tạo/deliver Outbox row.

#### Finding F-02 `[PARTIAL]` — Structured Logging phân tán bằng `console.*`, thiếu Context chuẩn và làm rơi `correlationId`
1. **Vị trí:** [`apps/api/src/http-app.ts`](../../apps/api/src/http-app.ts#L57), [`apps/api/src/errors.ts`](../../apps/api/src/errors.ts#L131), [`apps/api/src/main.ts`](../../apps/api/src/main.ts#L24-L58), [`apps/api/src/outbox.ts`](../../apps/api/src/outbox.ts#L343-L375), [`apps/api/src/pilot-admin.ts`](../../apps/api/src/pilot-admin.ts#L68), [`apps/api/src/realtime.ts`](../../apps/api/src/realtime.ts#L350-L364)
2. **Mô tả vấn đề:**
   - Không có `LoggerService` dùng chung: một số nơi in `console.log(JSON.stringify(...))` có `timestamp` (`errors.ts#L132`), nơi khác không có `timestamp` (`http-app.ts#L57`, `main.ts#L24,28,45`, `outbox.ts#L343`).
   - [`http-app.ts#L48`](../../apps/api/src/http-app.ts#L48) luôn tự sinh `randomUUID()` mới cho `correlationId`, bỏ qua request header `X-Correlation-ID` / `X-Request-ID` / `traceparent` hợp lệ (nếu client/proxy gửi vào để trace end-to-end), và không lưu `correlationId` vào `AsyncLocalStorage` nên các tầng sâu không tự truy cập được (dẫn tới `pilot-admin.ts#L68` ghi cứng `correlationId: ''` vào `Audit`).
   - Các hàm background/auth như `rate-limit.ts` (`503`), `auth.ts` (`login` failed), `realtime.ts` (`subscriber.on('error')`, broadcast failure) không có log JSON.
3. **Tác động production:** Khó correlate log giữa Caddy/LB, Next.js SSR, API HTTP access log, Outbox worker, và DB `Audit` table; lỗi Redis realtime và rate-limit 503 không xuất hiện trong log pipeline.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Tạo `StructuredLogger` module thống nhất format (`timestamp`, `level`, `service`, `code`, `correlationId`, `message/errorType`, redact rules) + `AsyncLocalStorage` cho request context (`correlationId`, `tenantId`, `storeId`, `userId` — tránh log PII).
   - Chấp nhận `X-Request-Id` / `X-Correlation-Id` đã sanitize định dạng UUID/alphanumeric ngắn từ proxy hoặc client, fallback `randomUUID()`.
   - Sửa `pilot-admin.ts#L68` nhận và ghi `correlationId` thật từ request.
6. **Acceptance Criteria:**
   - Mọi JSON log lines từ API & Worker có schema thống nhất (bao gồm `timestamp`, `level`, `service`).
   - `Audit` row của `acceptInvitation` ghi đúng `correlationId` của request.
   - `realtime.ts` subscriber error và `rate-limit.ts` `503` ghi structured `warn`/`error` log.
7. **Tests cần có:** Unit tests cho `StructuredLogger` + integration tests verify `x-correlation-id` truyền tới `Audit` khi accept invitation và format JSON log hợp lệ.

---

### MIỀN G — Production Readiness & Operations

#### Finding G-01 `[RISK]` — Khoảng trống Backup/DR: Chỉ dùng `pg_dump` (RPO >= 5–15 phút, không có WAL PITR), lệch phiên bản PostgreSQL giữa CI (17) và Staging (18)
1. **Vị trí:** [`deploy/backup/backup.sh`](../../deploy/backup/backup.sh#L8-L62), [`deploy/compose.staging.yml`](../../deploy/compose.staging.yml#L25), [`deploy/compose.staging.yml`](../../deploy/compose.staging.yml#L162-L163), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml#L17)
2. **Mô tả vấn đề:**
   - Chiến lược backup hiện tại chạy `pg_dump --format=custom` mỗi `300s` (`BACKUP_INTERVAL_SECONDS=300`), cảnh báo stale ở `900s`. Hệ thống **chưa bật PostgreSQL WAL archiving / Point-in-Time Recovery (PITR)** (ví dụ `pgBackRest` hoặc `WAL-G`), nên khi gặp sự cố phần cứng/corruption/xóa nhầm dữ liệu giữa kỳ dump, toàn bộ giao dịch POS/thanh toán trong tối đa 5–15 phút cuối có nguy cơ mất trắng; đồng thời khi bảng lớn lên, `pg_dump` full mỗi 5 phút sẽ gây I/O và snapshot pressure kéo dài.
   - Version drift rõ rệt: CI (`.github/workflows/ci.yml#L17, #L101`) test trên `postgres:17-alpine` trong khi Staging (`deploy/compose.staging.yml#L25`) chạy `postgres:18-alpine`, còn root `package.json` `devDependencies` dùng `embedded-postgres: 18.4.0-beta.17` (phiên bản beta!).
   - Docker compose staging chạy Redis `appendonly yes` (`deploy/redis-start.sh#L7`) nhưng chưa thấy cấu hình persistence/offsite backup cho Redis nếu cần (chấp nhận được vì Redis chỉ giữ ephemeral rate-limit + pubsub, nhưng cần verify rõ trong ops doc và giữ AOF hoặc đánh đổi có chủ đích).
3. **Tác động production:** Mất dữ liệu đơn hàng/thanh toán khi sự cố giữa hai lần `pg_dump`; nguy cơ hành vi SQL/planner/extension khác biệt giữa CI (Postgres 17) và Staging/Production (Postgres 18).
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:**
   - Đồng bộ version PostgreSQL giữa `.github/workflows/ci.yml` và `deploy/compose.staging.yml` (cùng một major version LTS ổn định, ví dụ `postgres:17-alpine` hoặc cùng lên `18-alpine` ổn định sau khi verify; bỏ/thay `embedded-postgres` beta bằng container hoặc bản stable trong dev).
   - Thiết kế lộ trình chuyển từ `pg_dump` thuần sang **Base backup + Continuous WAL archiving (PITR)** (như `pgBackRest` / `wal-g` đẩy encrypted WAL về object storage ngoài host) để giảm RPO xuống ~giây/phút và không dump full mỗi 5 phút khi dữ liệu tăng.
6. **Acceptance Criteria:**
   - CI và staging sử dụng cùng major version `postgres` image.
   - Tài liệu + cấu hình WAL/PITR hoặc cơ chế giảm RPO được chuẩn hóa và kiểm thử restore tại một timestamp cụ thể trên môi trường test.
7. **Tests cần có:** Restore drill script test khôi phục thành công tại checkpoint timestamp mới hơn base backup (PITR) và CI pipeline green trên đúng major version Postgres đồng nhất.

#### Finding G-02 `[MISSING]` — Cổng thanh toán Card mới là Sandbox Stub, chưa có Webhook Verification Pipeline
1. **Vị trí:** [`apps/api/src/card-provider.ts`](../../apps/api/src/card-provider.ts#L1-L17), [`apps/api/src/payments.ts`](../../apps/api/src/payments.ts#L28-L32), [`apps/api/src/http-app.ts`](../../apps/api/src/http-app.ts#L60)
2. **Mô tả vấn đề:** `LabeledCardSandboxAdapter.authorize()` (`card-provider.ts#L11-L15`) luôn ném `503 CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED`. Không có interface/adapter thanh toán thực tế (hoặc QR động VietQR/PayOS/VNPay/Stripe), không có webhook ingestion controller, HMAC signature verification, timestamp replay window, hay reconciliation job cho các `BANK_TRANSFER`/`CARD` payment bị treo ở trạng thái `PENDING`.
3. **Tác động production:** Chưa thể thu tiền tự động qua cổng thanh toán/thẻ trong production (chỉ ghi `CASH` hoặc manual `BANK_TRANSFER` cần manager duyệt tay từng giao dịch); giao dịch `PENDING` bị bỏ quên sẽ treo vô thời hạn nếu khách hủy ngang.
4. **Mức độ ưu tiên:** `P2` (nếu pilot chỉ chạy Cash + Manual Bank Transfer thì là `P2` cho M2, nâng lên `P0` nếu bật Card/QR auto-reconcile).
5. **Đề xuất giải pháp:**
   - Định nghĩa `PaymentGatewayPort` sạch (tách khỏi `Payments` command service), chuẩn bị webhook controller riêng `/webhooks/payments/:provider` với middleware kiểm tra HMAC + timestamp window + idempotency theo `providerEventId`.
   - Thêm expiry/cleanup policy cho các `BANK_TRANSFER` `PENDING` quá hạn (ví dụ tự đánh dấu `FAILED` bởi reconciliation job hoặc cảnh báo manager).
6. **Acceptance Criteria:**
   - Contract `PaymentGatewayPort` tách biệt rõ ràng; webhook endpoint có HMAC signature + replay guard + idempotent settlement tests (ít nhất với signed mock/sandbox provider chuẩn).
7. **Tests cần có:** Integration tests cho signed webhook callback hợp lệ -> `SETTLED`, replay webhook cũ -> idempotent no-op, sai chữ ký -> `401/403`, hết hạn -> `401`.

---

### MIỀN H — Testing Architecture & Gaps

#### Finding H-01 `[PARTIAL]` — Coverage Threshold ở CI quá thấp (45–55%) và bỏ trống hoàn toàn các file nghiệp vụ/runtime cốt lõi
1. **Vị trí:** [`vitest.config.ts`](../../vitest.config.ts#L9-L26), [`tests/`](../../tests/)
2. **Mô tả vấn đề:** Tại thời điểm audit baseline (`e79ad6f`), bộ test gồm 50 unit test cases thực thi qua 6 file (41 khai báo tĩnh trước khi Vitest mở rộng `it.each` gồm 9 case trong `tests/unit/deployment-security.test.ts` -> thực chạy `3 + 16 + 10 + 12 + 3 + 6 = 50`), 32 PostgreSQL integration tests (2 file), 2 Redis integration tests (2 file), 10 E2E Playwright tests (1 file), và 3 shell script tests cho backup. Tuy nhiên [`vitest.config.ts#L11-L13`](../../vitest.config.ts#L11-L13) chỉ ép ngưỡng CI tổng thể ở mức:
   - `lines: 55`, `statements: 45`, `branches: 48`, `functions: 45`
   - Các per-file thresholds (`L14-L22`) chỉ áp lên các file nhỏ (`auth.ts`, `domain.ts`, `catalog-domain.ts`, `rate-limit.ts`, `deployment-security.ts`, `card-provider.ts`, `contracts`), `commands.ts` chỉ yêu cầu `branches: 50, lines: 65`, trong khi **100% các module nặng nhất đều không có per-file coverage threshold**: `http.ts`, `http-app.ts`, `main.ts`, `operations.ts`, `payments.ts`, `cash-shifts.ts`, `catalog-operations.ts`, `qr-ordering.ts`, `pilot-admin.ts`, `realtime.ts`, `outbox.ts`, `worker.ts`, `errors.ts`.
3. **Tác động production:** Bug hoặc branch xử lý lỗi mới thêm vào controller, payments, refunds, cash shifts, hay realtime có thể rớt coverage xuống rất thấp mà CI `verify` vẫn xanh.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Nâng dần global coverage gates trong `vitest.config.ts` (ví dụ `lines >= 75, branches >= 70, functions >= 75`) và đặt per-file minimum thresholds cho các core files (`operations.ts`, `payments.ts`, `cash-shifts.ts`, `outbox.ts`, `realtime.ts`, `commands.ts`, `errors.ts`, `pilot-admin.ts`, `qr-ordering.ts`).
6. **Acceptance Criteria:**
   - Toàn bộ core backend files đều có coverage thresholds trong `vitest.config.ts` và CI `test:coverage:ci` pass không hạ chuẩn.
7. **Tests cần có:** Bổ sung unit & integration tests phủ các nhánh thiếu của `payments.ts`, `cash-shifts.ts`, `catalog-operations.ts`, `qr-ordering.ts`, `pilot-admin.ts`, `errors.ts`, `http.ts`.

#### Finding H-02 `[MISSING]` — Thiếu Concurrency Deadlock Stress Tests, Multi-Replica Realtime Polling Tests, Load/Soak Tests & Security/Abuse Tests chuyên sâu
1. **Vị trí:** [`tests/integration/`](../../tests/integration/), [`tests/redis/`](../../tests/redis/)
2. **Mô tả vấn đề:**
   - `tests/redis/api-replicas.test.ts` mới chỉ kiểm tra **shared rate limit** giữa 2 API processes trên endpoint `/auth/login` (`L29-L61`), hoàn toàn **chưa test Socket.IO multi-replica** (polling + WebSocket + Outbox event broadcast giữa nhiều API processes).
   - Thiếu concurrency stress tests mô phỏng xung đột deadlock thực tế (hàng chục requests `record CASH`, `decideRefund`, `close shift`, `accept order`, `item START/CANCEL` chạy đồng thời).
   - Thiếu test tải/bộ nhớ/pagination trên dữ liệu lớn (e.g. 50.000 `Movement` / `Order` rows) và thiếu chaos test nhẹ cho worker/Redis reconnect trong khi traffic đang chạy.
3. **Tác động production:** Những lỗi chỉ xuất hiện dưới tải đồng thời thực tế (lock-order deadlock, connection pool exhaustion, Socket.IO 400 Session ID unknown qua 2 replicas, slow query do thiếu index) chỉ được phát hiện khi khách hàng thật gặp sự cố.
4. **Mức độ ưu tiên:** `P1`
5. **Đề xuất giải pháp:** Bổ sung các nhóm test deterministic chạy được trong CI/staging:
   - Multi-replica Socket.IO + Outbox Redis adapter integration test (`tests/redis/`).
   - Concurrency contention integration tests trong `tests/integration/` dùng `Promise.all` trên các luồng chạm chung `Order`, `CashShift`, `Balance`, `StoreInvitation`.
   - Security boundary tests (tampered cookies, cross-tenant ID injection trên từng module mới, rate limit account lockout, malformed JSON/oversized payload `413`).
   - Soak/smoke load profile script (ví dụ `k6` hoặc `autocannon` optional job cho staging/nightly, không phải synthetic microbenchmark giả mạo).
6. **Acceptance Criteria:**
   - CI suite (`test`, `test:integration`, `test:redis`) chạy pass toàn bộ concurrency, multi-replica Socket.IO, và security boundary tests mới.
7. **Tests cần có:** Xem danh sách chi tiết trong `docs/M2_IMPLEMENTATION_PLAN.md`.

---

## 5. Tổng hợp ưu tiên (`P0` → `P3`)

| Priority | Mã Finding | Vấn đề cốt lõi |
| :---: | :--- | :--- |
| **P0** | **B-01** | Auth brute-force & NAT lockout: Rate limit chỉ theo IP, thiếu per-account lockout/backoff |
| **P0** | **D-01** | Multi-replica Socket.IO thiếu `@socket.io/redis-adapter`, nuốt lỗi subscriber Redis, chậm revoke socket |
| **P0** | **F-01** | Thiếu toàn bộ telemetry & `/metrics` (HTTP latency, rate-limit 429/503, outbox lag, `P2034` retries, pool) |
| **P1** | **A-01** | `http.ts` monolithic controller + thiếu NestJS DI/Guards/Pipes |
| **P1** | **A-02** | Kitchen device commands bypass `CommandBus` & thiếu Outbox invalidation khi revoke/assign |
| **P1** | **B-02** | Thiếu session management (`logout-all`, `revoke-sessions`, `switch-store`, TTL cleanup) |
| **P1** | **B-03** | `PilotAdmin` invitation race TOCTOU, missing DB partial unique index & `correlationId: ''` |
| **P1** | **B-04** | `TRUSTED_PROXY_CIDRS` từ chối subnet CIDR (`/24`, `/16`, `/64`) |
| **P1** | **C-01** | Thiếu index `Movement(tenantId, storeId, createdAt DESC)` cho truy vấn lịch sử |
| **P1** | **C-03** | Lock acquisition order không đồng nhất giữa `Orders` / `Payments` / `CashShifts` / `Refunds` |
| **P1** | **C-04** | `decideRefund` CASH ép manager phải có `CashShift` riêng mở đứng tên chính mình |
| **P1** | **C-05** | Thiếu DB role `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` & table retention cleanup |
| **P1** | **D-02** | Outbox quarantine chỉ trên RAM (`Set` 1000) thiếu persistent DLQ; `worker.ts` bật `enableOfflineQueue` |
| **P1** | **D-03** | `CommandBus` retry sai `P2002`, không jitter, cumulative timeout ~80s, non-canonical JSON hash |
| **P1** | **E-01** | Thiếu API versioning (`/v1`), endpoint movements trùng lặp, unbounded/nested payloads lớn |
| **P1** | **E-02** | Thiếu HTTP server timeouts & JSON limit tường minh; Origin gate chặn `/webhooks/*`; query `?token=` fallback |
| **P1** | **F-02** | Structured logger phân mảnh, thiếu `AsyncLocalStorage`, rơi `correlationId`, im lặng ở rate-limit/realtime errors |
| **P1** | **G-01** | Backup chỉ có `pg_dump` (không WAL/PITR) + Postgres version drift CI (17) vs Staging (18) vs beta dev |
| **P1** | **H-01** | Coverage gate ở CI thấp (`45–55%`) và bỏ qua toàn bộ core runtime/service files |
| **P1** | **H-02** | Thiếu multi-replica Socket.IO tests & high-concurrency deadlock integration tests |
| **P2** | **C-02** | `uniqueName` đọc full table vào JS & `Category` bị archive chặn trùng tên vĩnh viễn |
| **P2** | **D-04** | `QrOrdering.createTable`/`regenerate` vỡ idempotent retry (`409` trên same key) |
| **P2** | **G-02** | Card payment mới là sandbox stub, chưa có webhook verification & `PENDING` reconciliation |
| **P3** | **C-06** | Hardcode `Asia/Ho_Chi_Minh` (chấp nhận ở VN pilot, mở rộng sau khi đa quốc gia) |

---

## 6. Đánh giá mức độ sẵn sàng hiện tại (Readiness Verdict)

- **Pilot một cụm nhỏ / single-host (`isolated-single-host`, Cash + manual Bank Transfer):** **ĐẠT CÓ ĐIỀU KIỆN** (Core invariants về tồn kho, tiền, hóa đơn, và fail-closed security đã tốt; cần hoàn thành nhóm **P0** + phần lớn **P1** trước khi tăng lưu lượng hoặc chạy multi-replica).
- **Multi-tenant SaaS quy mô lớn / Multi-replica HA / Senior Production Portfolio:** **CHƯA SẴN SÀNG** cho tới khi hoàn tất tách module DI (`A-01`), chuẩn hóa Observability/Metrics (`F-01`, `F-02`), Multi-replica Socket.IO Redis Adapter (`D-01`), Outbox Persistent DLQ (`D-02`), Lock Ordering & Concurrency hardening (`C-03`, `D-03`), Auth Lockout & Session lifecycle (`B-01`, `B-02`), và nâng Test/CI Coverage Gates (`H-01`, `H-02`).
