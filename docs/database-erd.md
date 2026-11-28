# OMNIHUB Database Entity Relationship Diagram (ERD)

This document describes the PostgreSQL data model implemented in [`prisma/schema.prisma`](../prisma/schema.prisma) (`36` Prisma models across `14` migrations). Every store-scoped table carries `(tenantId, storeId)` and enforces composite foreign keys with `ON DELETE RESTRICT` so cross-tenant references are rejected at the database layer.

---

## 1. Core Financial, Order, Inventory & Outbox ERD

This diagram covers the primary transactional, accounting, inventory ledger, and event delivery models.

```mermaid
erDiagram
    Tenant {
        uuid id PK
        string name
    }

    Store {
        uuid id PK
        uuid tenantId FK
        string name
        string timezone
        int dayStart
        boolean qrOrderingEnabled
    }

    Order {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid tableSessionId FK "nullable"
        OrderStatus status "ACCEPTED|COMPLETED|CANCELLED"
        string paymentStatus "UNPAID|PARTIALLY_PAID|PAID|PARTIALLY_REFUNDED|REFUNDED"
        string channel "POS|QR"
        int total "VND integer"
        int version
        string trackingTokenHash UK "nullable"
        datetime createdAt
    }

    OrderItem {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid orderId FK
        uuid ticketId FK
        uuid productId "logical ref (no DB FK)"
        string name
        string preparationNote
        int unitPrice
        int recipeVersion
        json recipeSnapshot
        json selectionSnapshot
        ItemStatus status "PENDING|PREPARING|READY|HANDED_OFF|CANCELLED"
    }

    BillSplit {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid orderId FK
        string label
        int amount
        json itemIds
        string commandKey UK
        datetime createdAt
    }

    Payment {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid orderId FK
        uuid cashShiftId FK "nullable"
        uuid splitId FK "nullable"
        uuid cashierId "actor ref"
        int amount
        int tendered
        int change
        string method "CASH|BANK_TRANSFER|CARD"
        string status "PENDING|SETTLED|FAILED"
        string externalReference "nullable"
        string idempotencyKey UK
        string businessDate
        datetime createdAt
    }

    Refund {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid orderId FK
        uuid paymentId FK
        uuid itemId "nullable, logical ref"
        int amount
        string reason
        string businessDate
        string status "REQUESTED|APPROVED|REJECTED"
        uuid requestedBy
        uuid approvedBy "nullable"
        string commandKey UK
        datetime createdAt
        datetime approvedAt "nullable"
    }

    RefundDecision {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid refundId FK "unique per store"
        uuid actorId
        string decision "APPROVED|REJECTED"
        string reason
        datetime createdAt
    }

    CashRegister {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name UK
        boolean active
        int version
    }

    CashShift {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid registerId FK
        uuid cashierId
        string status "OPEN|CLOSING|CLOSED"
        string approvalStatus "NOT_REQUIRED|PENDING|APPROVED"
        string businessDate
        int openingAmount
        int expectedAmount "nullable"
        int countedAmount "nullable"
        int discrepancy "nullable"
        string reason "nullable"
        uuid approvedBy "nullable"
        int version
        datetime openedAt
        datetime closingAt "nullable"
        datetime closedAt "nullable"
        datetime approvedAt "nullable"
    }

    CashMovement {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid shiftId FK
        string commandKey UK
        string kind "CASH_IN|CASH_OUT|REFUND|CORRECTION_IN|CORRECTION_OUT"
        int amount
        string reason
        uuid paymentId "nullable, logical ref"
        uuid refundId UK "nullable, logical ref"
        uuid actorId
        datetime createdAt
    }

    Ingredient {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name
        string unit
        boolean active
        int version
        decimal lowStockThreshold
        datetime deletedAt "nullable"
    }

    Balance {
        uuid tenantId PK,FK
        uuid storeId PK,FK
        uuid ingredientId PK,FK
        decimal onHand
        decimal reserved
    }

    Reservation {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid itemId FK
        uuid ingredientId FK
        decimal quantity
        ReservationStatus status "RESERVED|CONSUMED|RELEASED"
    }

    StockReceipt {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string reference UK
        string supplier
        uuid actorId
        json lines
        datetime createdAt
    }

    Movement {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid ingredientId FK
        uuid itemId FK "nullable"
        uuid receiptId FK "nullable"
        string commandKey
        string kind "RESERVE|CONSUME|RELEASE|WASTE|ADJUST|RECEIPT"
        decimal onHandDelta
        decimal reservedDelta
        decimal wasteQuantity
        string reason "nullable"
        datetime createdAt
    }

    Outbox {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string type
        uuid aggregateId "decoupled aggregate ref"
        int version
        string correlationId
        datetime createdAt
        datetime deliveredAt "nullable"
        int attempts
        int maxAttempts
        datetime nextAttemptAt
        string lastError "nullable"
        datetime deadLetteredAt "nullable"
    }

    Audit {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid actorId
        string action
        uuid entityId
        string commandKey
        string correlationId
        json details "nullable"
        datetime createdAt
    }

    CommandReceipt {
        uuid tenantId PK,FK
        uuid storeId PK,FK
        string key PK
        string hash
        json response
        datetime createdAt
    }

    Tenant ||--o{ Store : "owns"
    Store ||--o{ Order : "scopes"
    Store ||--o{ CashRegister : "scopes"
    Store ||--o{ CashShift : "scopes"
    Store ||--o{ CashMovement : "scopes"
    Store ||--o{ Ingredient : "scopes"
    Store ||--o{ StockReceipt : "scopes"
    Store ||--o{ Outbox : "emits"
    Store ||--o{ Audit : "logs"
    Store ||--o{ CommandReceipt : "deduplicates"

    Order ||--o{ OrderItem : "contains"
    Order ||--o{ BillSplit : "splits into"
    Order ||--o{ Payment : "paid by"
    Order ||--o{ Refund : "refunded by"

    BillSplit |o--o{ Payment : "optionally allocates"
    Payment ||--o{ Refund : "compensates"
    Refund ||--o| RefundDecision : "decided once by"

    CashRegister ||--o{ CashShift : "hosts"
    CashShift |o--o{ Payment : "records cash"
    CashShift ||--o{ CashMovement : "logs drawer entries"

    Ingredient ||--o| Balance : "has 1-to-1 stock state"
    Ingredient ||--o{ Reservation : "reserved by"
    Ingredient ||--o{ Movement : "tracked in ledger"
    OrderItem ||--o{ Reservation : "reserves stock via"
    OrderItem |o--o{ Movement : "posts ledger entries"
    StockReceipt |o--o{ Movement : "posts receipts"
```

---

## 2. Authentication, Kitchen Operations, QR Ordering & Catalog ERD

This diagram documents the remaining identity, access control, kitchen ticket/device, QR table session, and menu catalog models in [`prisma/schema.prisma`](../prisma/schema.prisma).

```mermaid
erDiagram
    Store {
        uuid id PK
        uuid tenantId FK
        string name
    }

    User {
        uuid id PK
        string email UK
        string passwordHash
        boolean active
    }

    Membership {
        uuid userId PK,FK
        uuid storeId PK,FK
        uuid tenantId FK
        Role role "OWNER|MANAGER|CASHIER|KITCHEN|INVENTORY"
    }

    Session {
        string tokenHash PK
        uuid tenantId FK
        uuid storeId FK
        uuid userId FK
        datetime expiresAt
        datetime createdAt
    }

    StoreInvitation {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string email
        Role role
        string tokenHash UK
        uuid invitedBy FK
        datetime createdAt
        datetime expiresAt
        datetime acceptedAt "nullable"
        datetime revokedAt "nullable"
    }

    Station {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name
        boolean active
        int version
        datetime deletedAt "nullable"
    }

    KitchenDevice {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid userId FK
        uuid stationId FK "nullable"
        datetime createdAt
        datetime lastSeenAt
        datetime revokedAt "nullable"
    }

    KitchenTicket {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid orderId FK
        uuid stationId FK
        datetime createdAt
    }

    RestaurantTable {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name UK
        boolean active
        boolean qrEnabled
        string qrTokenHash UK
        int version
    }

    TableSession {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid tableId FK
        string sessionTokenHash UK
        string qrCredentialHash
        string status "OPEN|CLOSED"
        datetime expiresAt
        datetime closedAt "nullable"
    }

    Order {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid tableSessionId FK "nullable"
    }

    OrderItem {
        uuid id PK
        uuid orderId FK
        uuid ticketId FK
    }

    Category {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name
        boolean active
        int version
        datetime deletedAt "nullable"
    }

    Product {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid stationId FK
        uuid categoryId FK "nullable"
        string name
        int price
        boolean active
        boolean manualAvailable
        int version
        int recipeVersion
        datetime deletedAt "nullable"
    }

    RecipeItem {
        uuid productId PK,FK
        uuid ingredientId PK,FK
        uuid tenantId FK
        uuid storeId FK
        decimal quantity
    }

    RecipeRevision {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid productId FK
        int version UK
        json lines
        datetime createdAt
    }

    ProductVariant {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid productId FK
        string name
        int price
        decimal recipeMultiplier
        boolean active
        int version
        datetime deletedAt "nullable"
    }

    ModifierGroup {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid productId FK
        string name
        int minSelections
        int maxSelections
        boolean active
        int version
        datetime deletedAt "nullable"
    }

    Modifier {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        uuid groupId FK
        string name
        int priceDelta
        boolean active
        int version
        datetime deletedAt "nullable"
    }

    ModifierRecipeItem {
        uuid modifierId PK,FK
        uuid ingredientId PK,FK
        uuid tenantId FK
        uuid storeId FK
        decimal quantity
    }

    Ingredient {
        uuid id PK
        uuid tenantId FK
        uuid storeId FK
        string name
    }

    Store ||--o{ Membership : "grants access"
    User ||--o{ Membership : "joins stores"
    Store ||--o{ Session : "scopes"
    User ||--o{ Session : "authenticates"
    Store ||--o{ StoreInvitation : "issues"
    User ||--o{ StoreInvitation : "sends as inviter"

    Store ||--o{ Station : "operates"
    Store ||--o{ KitchenDevice : "registers"
    User ||--o{ KitchenDevice : "owns"
    Station |o--o{ KitchenDevice : "optionally restricts"

    Store ||--o{ RestaurantTable : "manages"
    Store ||--o{ TableSession : "scopes"
    RestaurantTable ||--o{ TableSession : "opens"
    TableSession |o--o{ Order : "places QR orders"

    Order ||--o{ KitchenTicket : "routes to stations"
    Station ||--o{ KitchenTicket : "receives"
    KitchenTicket ||--o{ OrderItem : "groups"

    Store ||--o{ Category : "organizes"
    Store ||--o{ Product : "sells"
    Category |o--o{ Product : "classifies"
    Station ||--o{ Product : "prepares"

    Product ||--o{ RecipeItem : "consumes"
    Ingredient ||--o{ RecipeItem : "used in"
    Product ||--o{ RecipeRevision : "versions"
    Product ||--o{ ProductVariant : "offers"
    Product ||--o{ ModifierGroup : "configures"
    ModifierGroup ||--o{ Modifier : "contains"
    Modifier ||--o{ ModifierRecipeItem : "adds ingredients"
    Ingredient ||--o{ ModifierRecipeItem : "used in"
```

---

## 3. Key Financial, Operational & Integrity Relationships

### Tenant and Store Ownership
- `Tenant` owns one or more `Store` rows (`Store.tenantId -> Tenant.id`, composite unique `@@unique([tenantId, id])`).
- All operational tables carry `(tenantId, storeId)` and reference composite keys on parent entities (for example, `Order` -> `Store(tenantId, id)`, `Payment` -> `Order(tenantId, storeId, id)`, `CashShift` -> `CashRegister(tenantId, storeId, id)`), preventing cross-tenant or cross-store joins even if an application query omits a filter.
- `User` accounts exist globally by unique `email` and join stores via `Membership` (`@@id([userId, storeId])`). `Session` rows bind a hashed cookie token (`tokenHash`) to one `(tenantId, storeId, userId)`.

### Order-to-Payment-to-Refund Accounting
- **Order -> Payment (1:N):** An `Order` can have multiple `Payment` records (`CASH`, `BANK_TRANSFER`, or sandbox `CARD`), supporting partial payments and split bills. `Payment.splitId` is an optional FK to `BillSplit`, and `Payment.cashShiftId` is an optional FK to `CashShift` (populated for `CASH` payments).
- **Payment -> Refund (1:N) & Refund -> RefundDecision (1:0..1):** Refunds are compensating entries tied by FK to both `Order` and a `SETTLED` `Payment` — settled payments are never mutated or deleted. `RefundDecision` enforces `@@unique([tenantId, storeId, refundId])`, guaranteeing at most one approval or rejection record per refund.
- **Order payment state invariant:** PostgreSQL `CHECK` constraint `order_payment_terminal` ensures `COMPLETED` orders have `paymentStatus` in `('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`, `ACCEPTED` orders allow `('UNPAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')` (supporting refunds against partially paid orders), and `CANCELLED` orders remain `UNPAID`.

### Cash Shifts and Cash Movements
- **CashRegister -> CashShift (1:N) -> CashMovement (1:N):** Each `CashRegister` hosts sequential `CashShift` sessions (`OPEN -> CLOSING -> CLOSED`). Cash drawer additions/deductions are recorded as append-only `CashMovement` entries (`CASH_IN`, `CASH_OUT`, `REFUND`, `CORRECTION_IN`, `CORRECTION_OUT`).
- **Logical references on `CashMovement`:** `CashMovement.paymentId` and `CashMovement.refundId` (`@@unique([tenantId, storeId, refundId])`) link cash refund movements back to `Payment` and `Refund` at the application and unique-index level rather than via direct Prisma `@relation` FKs.
- **Database immutability & discrepancy enforcement:** `CashShift_discrepancy_approval_check` prevents closing a shift with a non-zero discrepancy unless approved (`approvalStatus = 'APPROVED'`, `approvedBy IS NOT NULL`, `approvedAt IS NOT NULL`), and trigger `protect_closed_cash_shift()` forbids `DELETE` on any `CashShift` row and updates to `CLOSED` shifts.

### Order-to-Inventory Ledger
- **Ingredient <-> Balance (1:0..1):** `Balance` uses a composite primary key `(tenantId, storeId, ingredientId)` referencing `Ingredient`, storing `onHand` and `reserved` in `Decimal(18,3)`.
- **OrderItem -> Reservation (1:N) & Movement (1:N):** Accepting an order creates `Reservation` (`RESERVED`) rows and `Movement(kind = 'RESERVE')` entries per ingredient. Starting preparation transitions reservations to `CONSUMED` (`Movement(CONSUME)`); cancelling pending items transitions them to `RELEASED` (`Movement(RELEASE)`); cancelling started items posts `Movement(WASTE)`.
- **StockReceipt -> Movement (1:N):** Receiving stock creates an immutable `StockReceipt` and corresponding `Movement(kind = 'RECEIPT')` entries. `Movement.itemId` and `Movement.receiptId` are mutually optional FKs depending on the movement kind.
- **Historical recipe snapshots:** `OrderItem.productId` is stored as a logical UUID without a DB FK, and `OrderItem.recipeSnapshot` / `selectionSnapshot` capture the exact recipe and modifiers at order time so later catalog edits never alter historical orders.

### Transactional Outbox, Audit & Idempotency
- **Outbox -> Store (N:1, decoupled aggregate reference):** `Outbox` has a direct FK to `Store(tenantId, id)` and references domain records logically via `(type, aggregateId, version)`. Mutations persist business state, `Audit`, `CommandReceipt`, and `Outbox` rows in the same `Serializable` PostgreSQL transaction.
- **Retry & Dead Letter Queue state:** Migration `202611280001_financial_security_hardening` added `attempts`, `maxAttempts`, `nextAttemptAt`, `lastError`, and `deadLetteredAt` with `CHECK` constraint `Outbox_retry_integrity` (`attempts >= 0`, `maxAttempts >= 1`, and mutually exclusive `deliveredAt` / `deadLetteredAt`) plus partial indexes `Outbox_pending_ready_idx` and `Outbox_dead_letter_idx`.
