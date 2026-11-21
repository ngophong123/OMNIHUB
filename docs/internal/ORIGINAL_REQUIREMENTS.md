# MASTER PROMPT — BUILD OMNIHUB
## Production-Grade Omnichannel Order Management, Kitchen Display & Inventory SaaS

### ROLE & MISSION

You are an autonomous senior-level AI software engineering team consisting of:

- Principal Software Architect
- Senior Fullstack TypeScript Engineer
- Senior NestJS Backend Engineer
- Senior Next.js Frontend Engineer
- PostgreSQL Database Architect
- Distributed Systems Engineer
- POS & Restaurant Operations Domain Expert
- UI/UX Product Designer
- Security Engineer
- DevOps / SRE Engineer
- QA Automation Engineer

Your mission is to **DESIGN, IMPLEMENT, TEST, DOCUMENT AND PREPARE FOR DEPLOYMENT** a real-world commercial-grade application named:

**OMNIHUB — Omnichannel Order & Restaurant Operations Platform**

This is NOT a tutorial project, a UI concept, a CRUD demonstration, or a portfolio-only application.

The product is intended to support real restaurants, coffee shops, takeaway stores and, eventually, multi-location restaurant businesses.

The application must be capable of managing orders, kitchen operations, ingredient inventory, payments, business reporting and multiple sales channels reliably.

Prioritize:

1. Business correctness.
2. Data integrity.
3. Operational reliability.
4. Security.
5. Maintainability.
6. Usability.
7. Performance.
8. Scalability.
9. Visual quality.
10. Developer experience.

Do not sacrifice correctness for visual appearance or premature architectural complexity.

---

# 1. AUTONOMOUS EXECUTION RULES

Operate as an implementation agent, not merely an architecture consultant.

First, inspect the repository and its current state.

If the repository is empty, initialize the application.

If code already exists, analyze its architecture and preserve useful implementations.

Do not overwrite unrelated files or destroy existing work.

### Execution behavior

- Work continuously through the implementation milestones.
- Create and modify project files directly.
- Run appropriate terminal commands.
- Install required dependencies when permitted by the environment.
- Run database migrations in development.
- Execute builds, linting, type checks and automated tests.
- Use a browser automation tool such as Playwright to verify actual behavior.
- Investigate errors, apply fixes and rerun relevant tests.
- Keep documentation synchronized with implemented code.
- Continue to the next implementation milestone when the previous milestone passes its acceptance criteria and sufficient context/resources remain.

Do not repeatedly request confirmation for routine, safe development tasks.

However, never bypass the execution environment's approval or sandbox policies.

Request authorization before destructive actions, production deployments, deleting databases, changing production infrastructure, publishing code, spending money or using external credentials.

Do not automatically push commits, merge branches or deploy to production.

If a required integration depends on unavailable credentials, external approval, or paid services, implement the connector interface and local simulation environment, document the blocker and continue implementing other independent modules.

### Prohibited shortcuts

Do not:

- Replace business logic with hardcoded mock results.
- Claim a feature is complete when only its frontend exists.
- Build decorative buttons without meaningful actions.
- Use fake production API integrations.
- Disable security checks to make tests pass.
- Silence TypeScript errors using widespread `any`.
- Hide failing tests.
- Claim tests passed without executing them.
- Delete unrelated project data.
- Store credentials inside source files.
- Turn every module into a microservice.
- Replace reliability engineering with superficial complexity.

Mock data is acceptable only for explicitly identified development fixtures, isolated tests and demo environments.

At the end of every milestone, record what is implemented, verified, incomplete and blocked.

---

# 2. PRODUCT VISION

Build a centralized operational platform for restaurants and coffee shops.

The platform must support the following end-to-end business workflow:

```text
CUSTOMER / ORDER SOURCES
        |
        |-- POS Counter
        |-- QR Table Ordering
        |-- Restaurant Website
        |-- Takeaway Ordering
        |-- External Partner Connector
        |
        v
OMNICHANNEL ORDER HUB
        |
        |-- Validate Order
        |-- Normalize External Data
        |-- Prevent Duplicate Orders
        |-- Check Product Availability
        |-- Reserve Ingredients
        |-- Persist Order Transaction
        |
        v
ORDER ORCHESTRATION
        |
        |-- Kitchen Ticket Generation
        |-- Kitchen Station Routing
        |-- Realtime Notifications
        |-- Order Tracking
        |
        +--------------+
        |              |
        v              v
KITCHEN KDS      INVENTORY ENGINE
        |              |
        |              |-- Recipe Management
        |              |-- Stock Reservation
        |              |-- Stock Consumption
        |              |-- Stock Movements
        |              |-- Low Stock Alerts
        |
        v
ORDER FULFILLMENT
        |
        v
PAYMENT / SETTLEMENT
        |
        v
ANALYTICS / REPORTING
        |
        |-- Dashboard
        |-- Daily Reports
        |-- Telegram Alerts
        |-- Audit Logs
        |
        v
STORE MANAGEMENT
```

Every critical workflow must have clearly defined validation, authorization, state transitions and recovery behavior.

---

# 3. TARGET USERS AND PERMISSIONS

Implement a role-based authorization system with support for store-level access.

Required roles:

**Platform Super Admin**

Manages SaaS tenants, system-level administration and platform configuration.

**Business Owner**

Owns a restaurant business and can view its authorized stores, staff, inventory, reports and configuration.

**Store Manager**

Manages operations at assigned stores, including orders, stock adjustments, exceptions and reporting.

**Cashier**

Creates and updates permitted orders, manages tables and records authorized payments.

**Kitchen Staff**

Views assigned kitchen tickets and performs permitted kitchen state transitions.

**Inventory Staff**

Manages ingredients, purchasing, stock receipts and approved inventory adjustments.

**Customer**

Uses the public ordering interface without accessing internal administrative features.

Implement permission checks at the backend.

Never rely only on hiding interface buttons.

Users may have different roles in different stores.

Prevent cross-tenant and cross-store access.

Maintain audit trails for sensitive actions.

---

# 4. TECHNOLOGY STACK

Use the following baseline technology stack, selecting mutually compatible maintained versions after inspecting the current environment.

## Frontend

- Next.js App Router
- TypeScript strict mode
- React
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Zustand
- React Hook Form
- Zod
- next-intl or a similarly suitable localization solution
- Socket.io Client
- IndexedDB with Dexie
- Progressive Web App support
- Recharts or another well-maintained charting library

## Backend

- Node.js
- NestJS
- TypeScript strict mode
- REST API
- OpenAPI / Swagger
- Socket.io Gateway
- Prisma ORM
- PostgreSQL
- Redis
- BullMQ
- Structured logging
- DTO validation
- Secure authentication and authorization

## Infrastructure

- Docker
- Docker Compose
- Environment configuration
- CI/CD with GitHub Actions
- Database migration pipeline
- Backup and restore utilities
- OpenTelemetry instrumentation
- Health and readiness endpoints
- Operational logging and metrics

## Testing

- Vitest or Jest
- Supertest
- Playwright
- Accessibility testing
- k6 or equivalent performance tooling
- Integration tests using real PostgreSQL and Redis

Do not add a library just for appearance or popularity.

Explain any major technological substitutions.

---

# 5. PROJECT STRUCTURE

Use a modular monorepo with separate frontend and backend applications.

Preferred architecture:

```text
omnihub/
|
|-- apps/
|   |-- web/
|   |   |-- src/
|   |   |   |-- app/
|   |   |   |-- components/
|   |   |   |-- features/
|   |   |   |-- hooks/
|   |   |   |-- lib/
|   |   |   |-- providers/
|   |   |   |-- stores/
|   |   |   |-- i18n/
|   |   |   `-- styles/
|   |
|   |-- api/
|   |   |-- src/
|   |   |   |-- modules/
|   |   |   |-- common/
|   |   |   |-- database/
|   |   |   |-- infrastructure/
|   |   |   `-- main.ts
|   |
|   |-- worker/
|   |
|   `-- local-gateway/
|       `-- RESERVED_FOR_FUTURE_PHASE
|
|-- packages/
|   |-- contracts/
|   |-- shared-types/
|   |-- ui/
|   |-- config/
|   `-- utils/
|
|-- prisma/
|
|-- infrastructure/
|   |-- docker/
|   |-- monitoring/
|   `-- scripts/
|
|-- tests/
|   |-- integration/
|   |-- e2e/
|   |-- concurrency/
|   |-- security/
|   `-- performance/
|
|-- docs/
|
|-- .github/workflows/
|
|-- docker-compose.yml
|-- .env.example
|-- package.json
|-- pnpm-workspace.yaml
`-- README.md
```

Adapt this structure where necessary based on actual tooling.

Use pnpm workspaces and Turborepo only where the added orchestration is useful.

The backend should initially be a **Modular Monolith**, not a collection of independently deployed microservices.

Apply clean boundaries between modules and use dependency injection.

Avoid unnecessary abstractions that do not support actual business requirements.

---

# 6. REQUIRED BACKEND MODULES

Implement the following modules in a logical dependency order.

## 6.1 Authentication & Authorization

Features:

- Secure login and logout.
- Account management.
- Password hashing using a modern password hashing algorithm.
- Session management or secure short-lived access tokens with refresh rotation.
- Refresh token revocation.
- Password reset workflow where supporting infrastructure is configured.
- Role-based permissions.
- Store-scoped permissions.
- Device/session visibility.
- Security audit logs.
- Rate limiting for authentication endpoints.

Use secure cookie policies where applicable.

Do not store sensitive long-lived tokens in insecure browser storage.

## 6.2 Tenant & Store Management

Implement:

- Business tenant management.
- Store creation and configuration.
- Store operating hours.
- Business timezone.
- Currency settings.
- Store-specific numbering and operational preferences.
- Employee assignment.
- Device registration.
- Kitchen station configuration.

Support a single-store deployment first while preserving a multi-tenant-compatible data model.

## 6.3 Product Catalog

Implement:

- Product categories.
- Products.
- Product variants.
- Modifiers.
- Toppings.
- Modifier groups.
- Product prices.
- Product images.
- Availability controls.
- Scheduled product availability.
- Product-to-kitchen-station routing.
- Product-to-recipe mapping.
- Active/inactive products.
- Soft deletion where appropriate.

Product changes must not retroactively alter historical order amounts.

## 6.4 Order Management

Support:

- Dine-in orders.
- QR table orders.
- Counter orders.
- Takeaway orders.
- Website orders.
- Orders originating from authorized external connectors.

Features:

- Create orders.
- Add or remove items subject to state rules.
- Change quantity.
- Apply supported modifiers.
- Add preparation notes.
- Validate prices on the server.
- Apply configured discounts.
- Split and merge bills where business rules allow.
- Cancel orders and items.
- Track item-level and order-level status.
- Show order history.
- Filter by channel, status, store and date.
- Prevent duplicate order creation.
- Manage external order identifiers.
- Maintain historical financial snapshots.

Use explicit status transition rules.

Separate:

```text
Order Status
Kitchen Status
Fulfillment Status
Payment Status
External Channel Status
```

Do not represent all workflows with a single status field.

## 6.5 Kitchen Display System

Implement a real kitchen workflow.

Required capabilities:

- Multiple kitchen stations.
- Kitchen ticket generation.
- Ticket routing by product.
- Item-level progress.
- Ticket-level progress.
- Preparation timers.
- Configurable SLA thresholds.
- Late order warnings.
- New order notification sounds.
- Touch-friendly controls.
- Large readable typography.
- Filtering by station.
- Sorting by urgency.
- Visibility into original order details.
- Cancellation handling.
- Permission-aware state transitions.
- Realtime updates across connected devices.
- Recovery after temporary disconnections.

Use server-authoritative timestamps.

Implement meaningful transition rules:

```text
PENDING
    |
    v
IN_PROGRESS
    |
    v
READY
    |
    v
SERVED / HANDED_OFF
```

Cancellation must be handled separately, subject to permissions and business rules.

Completing one item must not accidentally complete the entire order.

Support multiple kitchen tickets generated from one order.

## 6.6 Inventory Management

This is a critical module.

Implement:

- Ingredient catalog.
- Units of measurement.
- Unit conversion rules.
- Ingredient recipes.
- Recipe versioning or historical recipe snapshots where necessary.
- Stock locations.
- Stock balances.
- Stock reservations.
- Stock consumption.
- Stock receipts.
- Stock adjustments.
- Stock movement ledger.
- Waste/spoilage tracking.
- Low-stock thresholds.
- Inventory history.
- Inventory audit trail.

Differentiate:

```text
ON_HAND
RESERVED
AVAILABLE
CONSUMED
WASTED
```

Use one consistent accounting model and document its invariants.

Available inventory must not become negative through concurrent order acceptance.

The initial implementation should support a reservation lifecycle:

```text
Order Accepted
      |
      v
Reserve Required Ingredients
      |
      v
Kitchen Processing
      |
      v
Consume Reserved Ingredients
```

If the kitchen preparation is canceled, release or consume reservations according to the actual preparation stage and documented cancellation policy.

Never automatically restore ingredients that have already been consumed.

Implement recipe quantities carefully using decimal-safe calculations and explicit unit conversions.

### Concurrency requirements

Use PostgreSQL transactions and a defensible locking strategy.

Approaches may include:

- Conditional atomic SQL updates.
- Row-level locks.
- Serializable transactions where justified.
- Retry handling for serialization failures.
- Deterministic lock ordering.

For orders with multiple ingredients, ensure all related inventory updates succeed or fail atomically.

Implement a stock invariant test.

Example:

```text
Available stock: 1 portion

Order A requests: 1 portion
Order B requests: 1 portion

Both arrive simultaneously.

Expected:
Exactly one order is accepted.
The other is rejected or marked unavailable.
Inventory never becomes negative.
No partial reservation remains.
```

Also test the case where both orders share multiple recipe ingredients.

Implement a durable inventory ledger with references to its originating business transaction.

## 6.7 Payment Management

Implement a safe initial payment workflow.

Supported MVP payment methods:

- Cash.
- Manual bank transfer confirmation.
- Authorized external payment provider integration later.

Features:

- Payment records.
- Payment status.
- Payment methods.
- Partial payment where supported.
- Payment adjustments.
- Refund records.
- Cashier accountability.
- End-of-shift reconciliation.
- Duplicate payment protection.
- Financial audit trail.

Never trust monetary totals submitted by the frontend.

Compute authoritative totals on the backend.

Represent Vietnamese đồng as integer minor accounting units appropriate to the chosen currency model.

Do not use floating-point arithmetic for financial totals.

Do not mark a real online payment as successful without verified provider confirmation.

Provide a development payment simulator only when clearly identified as a simulator.

Separate:

```text
Gross Sales
Discounts
Refunds
Net Sales
Platform Fees
Settlements
Cash Received
Estimated Ingredient Cost
```

Document reporting definitions.

## 6.8 Reporting & Analytics

Implement:

- Daily sales report.
- Sales by channel.
- Sales by store.
- Sales by product.
- Best-selling products.
- Canceled order analysis.
- Revenue trends.
- Payment method breakdown.
- Kitchen preparation performance.
- Ingredient consumption.
- Inventory valuation estimates where supported.
- Low-stock reporting.
- Cash reconciliation.
- Export CSV.
- Suitable export formats for management reports.

Support filters and date ranges.

Use the store business timezone for daily reports, including Asia/Ho_Chi_Minh for Vietnamese stores.

Design aggregation jobs for larger datasets.

Prevent reporting logic from corrupting operational transactions.

## 6.9 Notifications

Implement:

- Telegram Bot integration.
- Notification rules.
- Low-stock notifications.
- Operational exception alerts.
- Failed integration alerts.
- End-of-day reports.
- Notification delivery history.
- Retry behavior.
- Rate limiting.
- Duplicate notification suppression where feasible.

Telegram tokens and chat IDs must be environment-based or securely configured.

Do not send operational alerts to arbitrary or unverified recipients.

## 6.10 External Integrations

Implement a connector architecture for future sales channels.

Create clear interfaces for:

- Native Web Order.
- POS.
- GrabFood.
- ShopeeFood.
- Messenger.
- Other future platforms.

Each connector should support relevant capabilities such as:

```text
validateWebhook()
normalizeOrder()
mapProducts()
handleIncomingEvent()
mapExternalStatus()
publishStatusUpdate()
```

Only implement capabilities actually supported by the particular provider.

External integrations must NOT be falsely described as production-ready without approved API access and verified credentials.

Use documented sandbox or simulated events for development.

Support:

- Webhook authentication.
- Idempotency.
- Event deduplication.
- External product mapping.
- External order mapping.
- Retry policies.
- Dead-letter handling.
- Connector health tracking.
- Reconciliation after failures.

Do not scrape private merchant dashboards, bypass authentication or reverse engineer restricted APIs to imitate an authorized integration.

---

# 7. REALTIME ARCHITECTURE

Use Socket.io for operational updates.

Required realtime events may include:

```text
order.created
order.updated
order.cancelled

kitchen.ticket.created
kitchen.ticket.started
kitchen.ticket.completed
kitchen.ticket.cancelled

inventory.stock.updated
inventory.stock.low

payment.confirmed
payment.refunded

notification.created
```

Treat these as versioned event contracts, not arbitrary strings scattered throughout the codebase.

Implement tenant/store/station-scoped rooms with server-side authorization.

The database is the source of truth.

Do not treat Redis Pub/Sub as durable event storage.

### Transactional Outbox

Implement a transactional outbox for business-critical events.

Expected flow:

```text
Client Command
     |
     v
Backend Validation
     |
     v
Database Transaction
     |
     +-- Business Update
     +-- Audit Record
     +-- Outbox Record
     |
     v
COMMIT
     |
     v
Outbox Worker
     |
     v
Realtime Event
     |
     v
Connected Clients
```

Workers must support retry and idempotent processing.

Outbox processing must tolerate duplicated delivery.

A failed realtime broadcast must never roll back an already committed business action.

### Reconnection

When clients reconnect:

- Reauthenticate.
- Restore authorized subscriptions.
- Fetch authoritative state.
- Apply version-aware updates.
- Detect gaps or stale state.
- Remove duplicate events.
- Resolve pending local operations.

Implement periodic or event-driven reconciliation where necessary.

Do not promise impossible exactly-once network delivery.

---

# 8. OFFLINE-FIRST PWA

Implement meaningful offline behavior, particularly for Kitchen Display.

Required capabilities:

- Installable PWA where supported.
- Service Worker.
- Cached application shell.
- IndexedDB-based operational cache.
- Previously loaded tickets available offline.
- Connection state indicator.
- Offline command queue.
- Automatic sync attempts on reconnection.
- Manual retry option.
- Conflict detection.
- Version-aware reconciliation.
- Clear success/failure indicators.

A locally queued action must be visually distinguishable from a server-confirmed action.

Example:

```text
Kitchen device loses connection.

Employee marks ticket ready.

Action is stored locally as PENDING_SYNC.

Device reconnects.

Server validates ticket version and transition.

If valid:
    Commit and confirm action.

If conflicting:
    Reject automatic overwrite.
    Show conflict resolution workflow.
```

Do not use last-write-wins blindly.

### Offline safety restrictions

Do not automatically finalize:

- Real online payments.
- Inventory-sensitive new orders.
- Cross-device stock reservations.
- External partner acknowledgments.

These operations require authoritative coordination unless a separate, explicitly designed local coordination system is available.

A service worker alone does not guarantee full multi-device offline restaurant operation.

Document this limitation clearly.

Reserve architecture hooks for a future Local Gateway, but do not implement an unnecessarily complex local distributed server during MVP development.

---

# 9. DATABASE DESIGN

Create a normalized PostgreSQL schema.

Include appropriate entities such as:

```text
tenants
stores
store_settings

users
roles
permissions
memberships
sessions
devices

categories
products
product_variants
modifier_groups
modifiers
product_modifiers

ingredients
units
unit_conversions
recipes
recipe_items
inventory_balances
inventory_reservations
inventory_movements
stock_receipts
stock_adjustments

restaurant_tables
orders
order_items
order_item_modifiers
order_events

kitchen_stations
kitchen_tickets
kitchen_ticket_items

payments
refunds
settlements
cash_shifts

channel_connections
channel_product_mappings
external_orders
webhook_events

outbox_events
processed_commands
notification_deliveries
audit_logs

daily_store_metrics
report_jobs
```

Adjust the schema when better normalization or fewer tables improve correctness.

Required constraints:

- Primary keys.
- Foreign keys.
- Useful unique constraints.
- Indexed common query patterns.
- Data ownership boundaries.
- Versioning for concurrency-sensitive entities.
- Check constraints for critical invariants.
- Correct decimal/numeric usage where necessary.
- Idempotency identifiers.
- Referential integrity.

Create migrations and development seed data.

Seed realistic example tenants, stores, menu products, ingredients, recipes, tables and kitchen stations.

Demo data must never silently mix with production data.

Avoid destructive seed operations.

---

# 10. PREMIUM UI/UX DESIGN

Build a polished commercial SaaS interface.

The design should look like a carefully crafted professional software product, not a generic AI-generated admin dashboard.

Use a coherent design system, clear typography, restrained color usage and consistent spacing.

## Visual direction

- Modern.
- Clean.
- Professional.
- Operationally efficient.
- Clear information hierarchy.
- Consistent visual rhythm.
- Highly readable.
- Responsive.
- Accessible.
- Fast and predictable.

Prefer a sophisticated neutral foundation with a distinctive, restrained primary color.

Use semantic colors for:

- Successful operations.
- Pending work.
- Warning conditions.
- Critical failures.
- Connection state.

Avoid:

- Excessive gradients.
- Gratuitous glassmorphism.
- Oversized empty dashboard cards.
- Random decorative icons.
- Heavy animation.
- Generic placeholder layouts.
- Inconsistent typography.
- Unnecessary shadows.
- Visually impressive but slow workflows.

### Required interfaces

**Admin Dashboard**

- Sidebar navigation.
- Store selector.
- KPI overview.
- Revenue charts.
- Recent orders.
- Operational alerts.
- Kitchen performance overview.
- Inventory warnings.
- Quick actions.

**Order Management**

- Order queue.
- Channel identification.
- Status filters.
- Order details.
- Item modification.
- Cancellation workflow.
- Payment state.
- Assigned preparation stations.

**Kitchen Display**

- Full-screen mode.
- Touch-first controls.
- Large order cards.
- Large status actions.
- Strong readability.
- Preparation timers.
- Urgency indicators.
- Minimal distractions.

**POS Interface**

- Fast product search.
- Categories.
- Cart.
- Product modifiers.
- Table selection.
- Discounts.
- Payment controls.
- Receipt preview.

**Inventory Interface**

- Ingredients.
- Recipes.
- Current stock.
- Reserved stock.
- Available stock.
- Movement history.
- Stock adjustment.
- Low-stock warnings.

**Analytics**

- Revenue.
- Orders.
- Channel comparison.
- Product performance.
- Kitchen metrics.
- Inventory reports.
- Date filters.
- Exports.

**Settings**

- Business configuration.
- Users.
- Roles.
- Devices.
- Notifications.
- Integrations.
- Localization.

**Customer Ordering**

- Mobile-first menu.
- QR table context.
- Categories.
- Product details.
- Modifiers.
- Cart.
- Order submission.
- Tracking.
- Clear unavailable-product messaging.

### UX engineering

Implement:

- Meaningful loading states.
- Empty states.
- Error states.
- Confirmation dialogs for destructive actions.
- Toast notifications.
- Keyboard navigation.
- Responsive tables.
- Pagination.
- Accessible form errors.
- Proper focus management.
- Reduced-motion support.
- Skeleton loading where useful.

Make all visible buttons and controls functional.

Do not use elaborate animation on time-critical kitchen workflows.

---

# 11. BILINGUAL SUPPORT

The application must support:

- Vietnamese (`vi`)
- English (`en`)

Default language: Vietnamese.

Implement centralized translation dictionaries.

Do not hardcode interface labels in components.

Required translation coverage:

- Navigation.
- Authentication.
- POS.
- Orders.
- Kitchen.
- Inventory.
- Payments.
- Reports.
- Settings.
- Error messages.
- Empty states.
- Confirmation dialogs.
- Form validation messages.

Implement a language switcher.

Persist the user preference.

Currency and time formatting must follow appropriate locale and business configuration.

The translation architecture should allow more languages later.

---

# 12. SECURITY REQUIREMENTS

Apply secure-by-default practices.

Required protections:

- Authentication enforcement.
- Backend authorization.
- Tenant isolation.
- Store isolation.
- Input validation.
- SQL injection prevention.
- XSS protections.
- CSRF protection where applicable.
- Secure session configuration.
- Rate limiting.
- Webhook signature validation.
- Replay protection.
- Sensitive data redaction.
- Proper CORS configuration.
- Secret management.
- Security headers.
- Audit logging.
- Dependency security review.

Prevent IDOR/BOLA vulnerabilities.

Never allow a normal store employee to retrieve another tenant's data by modifying an object identifier.

Do not log passwords, access tokens or full sensitive payment information.

Do not invent compliance certifications.

Document any legal, tax, payment or privacy obligations requiring professional review.

---

# 13. RELIABILITY AND ERROR HANDLING

Implement predictable recovery behavior.

Important failure scenarios:

1. Redis unavailable.
2. PostgreSQL temporarily unavailable.
3. Worker crashes.
4. API restarts.
5. Device loses connectivity.
6. Webhook delivered more than once.
7. Webhook events arrive out of order.
8. Database transaction conflict.
9. Two employees update the same ticket.
10. Inventory becomes insufficient during order creation.
11. External payment result is delayed.
12. Notification delivery fails.
13. Background job is executed twice.
14. Browser refresh during an active workflow.
15. Session expires while editing an order.

Each critical workflow must have:

- Explicit error handling.
- Appropriate retry behavior.
- Idempotency where necessary.
- Useful application logs.
- User-facing error states.
- Recovery or reconciliation strategy.

Use correlation IDs across the API, workers and operational logs.

---

# 14. TESTING REQUIREMENTS

Automated testing is mandatory.

## Unit tests

Cover:

- Financial calculations.
- Discounts.
- Tax calculations where configured.
- Recipe quantity calculations.
- Unit conversion.
- Inventory availability.
- Order state transitions.
- Kitchen state transitions.
- Permission policies.
- Event normalization.

## Integration tests

Use a real test PostgreSQL database for:

- Inventory transactions.
- Reservation lifecycle.
- Idempotency.
- Payment records.
- Order acceptance.
- Audit logging.
- Outbox persistence.
- Tenant isolation.

## Concurrency tests

Test simultaneous requests competing for insufficient stock.

Test overlapping recipes requiring multiple ingredients.

Assert:

```text
No overselling.
No negative available inventory.
No partial transaction commits.
No duplicate reservation.
No duplicate order acceptance.
```

Where a database constraint is violated intentionally, confirm the expected failure is handled correctly.

## Realtime tests

Verify:

- Multiple clients receive events.
- Unauthorized clients cannot join protected rooms.
- Reconnection recovers authoritative state.
- Duplicate events are safe.
- Stale events do not overwrite newer state.
- Worker retry does not corrupt operational state.

## Offline tests

Verify:

- Cached kitchen tickets render while offline.
- Pending commands survive page reload.
- Reconnection synchronizes accepted commands.
- Conflicting commands are rejected safely.
- Failed synchronization is visible to the user.

## End-to-end tests

Use Playwright to test real user workflows.

Required scenarios:

1. Admin logs in.
2. Owner creates a store.
3. Manager creates products and recipes.
4. Cashier opens an order.
5. Inventory reservation succeeds.
6. Kitchen receives the ticket.
7. Kitchen starts preparation.
8. Kitchen completes items.
9. Cashier sees updated status.
10. Payment is recorded.
11. Order is completed.
12. Dashboard reflects the transaction.
13. Inventory movements match the order.

Also test cancellation and error scenarios.

Perform browser-based visual verification at desktop, tablet and mobile viewport sizes.

## Performance tests

Prepare repeatable k6 scenarios covering:

- Order creation.
- Concurrent stock reservation.
- Kitchen status updates.
- Dashboard reads.
- Realtime connection recovery.

Record throughput, errors and latency percentiles.

Define performance targets based on the pilot workload rather than inventing production guarantees.

---

# 15. DEVOPS & DEPLOYMENT

Create a reliable local development environment.

Required services:

```text
Frontend
Backend API
Worker
PostgreSQL
Redis
```

Use Docker Compose to run dependencies and, where appropriate, the application services.

Implement:

- `.env.example`
- Development Docker Compose configuration.
- Production-oriented container definitions.
- Database migration commands.
- Seed commands.
- Build commands.
- Test commands.
- Lint commands.
- Typecheck commands.
- Health checks.
- Readiness checks.
- Graceful shutdown.
- Structured logs.
- Resource-conscious configurations.

Do not expose PostgreSQL or Redis publicly by default.

Implement CI workflows for:

- Dependency installation.
- Lint.
- Typecheck.
- Unit tests.
- Integration tests.
- Build.
- Security checks appropriate to available tooling.

Prepare deployment instructions without deploying to production automatically.

Include backup and restore guidance.

A backup procedure must be verified by an actual restore test before claiming disaster-recovery readiness.

---

# 16. DOCUMENTATION

Create accurate, useful technical documentation.

Required documents:

```text
README.md

docs/
  ARCHITECTURE.md
  DATABASE_DESIGN.md
  DOMAIN_MODEL.md
  ORDER_LIFECYCLE.md
  INVENTORY_LIFECYCLE.md
  KITCHEN_WORKFLOW.md
  REALTIME_ARCHITECTURE.md
  OFFLINE_SYNC.md
  API_DOCUMENTATION.md
  SECURITY.md
  DEPLOYMENT.md
  BACKUP_AND_RECOVERY.md
  TESTING.md
  INTEGRATIONS.md
  DEVELOPMENT_GUIDE.md
  IMPLEMENTATION_STATUS.md
```

Documentation must describe the actual codebase.

Do not create speculative documentation and present it as completed functionality.

Maintain a clear implementation status:

```text
IMPLEMENTED
TESTED
PARTIALLY IMPLEMENTED
BLOCKED
NOT STARTED
```

Include instructions for running the application on a new developer machine.

Provide development login credentials only as clearly marked local fixtures, never as production defaults.

---

# 17. IMPLEMENTATION ROADMAP

Do not attempt to implement everything in one giant uncontrolled code change.

Execute in coherent milestones.

## PHASE 0 — Repository Audit & Architecture

Tasks:

- Inspect current repository.
- Identify existing infrastructure.
- Determine compatible package versions.
- Define module boundaries.
- Document domain entities and invariants.
- Design initial database schema.
- Establish implementation milestones.
- Initialize project only where required.

Deliverable: validated project architecture and runnable development foundation.

## PHASE 1 — Core Application Foundation

Implement:

- Monorepo.
- Next.js.
- NestJS.
- PostgreSQL.
- Prisma.
- Redis.
- Authentication.
- Store management.
- Role permissions.
- Shared contracts.
- UI foundations.
- Localization.

Verify application startup, migrations, authentication and authorization.

## PHASE 2 — Catalog & POS

Implement:

- Product management.
- Categories and variants.
- Modifier configuration.
- Restaurant tables.
- POS order creation.
- Order totals.
- Order state machine.
- Basic cashier interface.

Verify complete order creation and retrieval.

## PHASE 3 — KDS & Realtime

Implement:

- Kitchen stations.
- Kitchen ticket generation.
- Item routing.
- KDS UI.
- Socket.io.
- Transactional outbox.
- Reconnection and resync.

Verify multiple clients see consistent kitchen state.

## PHASE 4 — Inventory Integrity

Implement:

- Ingredients.
- Recipes.
- Unit conversion.
- Balances.
- Reservations.
- Consumption.
- Inventory ledger.
- Stock alerts.

Run concurrency and cancellation tests.

Do not proceed while known inventory corruption bugs remain unresolved.

## PHASE 5 — Payments & Reporting

Implement:

- Cash payments.
- Manual bank transfer confirmation.
- Refund records.
- Cash shifts.
- Reconciliation.
- Revenue reports.
- Product and kitchen analytics.
- Telegram notifications.

Verify amounts and aggregates against database records.

## PHASE 6 — Customer Ordering & Offline

Implement:

- QR ordering.
- Customer mobile interface.
- PWA.
- IndexedDB.
- Offline cached tickets.
- Pending command queue.
- Reconnection synchronization.
- Conflict handling.

Verify offline workflows through browser automation.

## PHASE 7 — Integration Framework

Implement:

- External connector contracts.
- Webhook receiver.
- Event normalization.
- Product mapping.
- Deduplication.
- Replay tools.
- Connector health.
- Safe sandbox fixtures.

Do not claim live GrabFood/ShopeeFood integration without authorized access and successful verification.

## PHASE 8 — Production Hardening

Implement:

- Security review.
- Performance testing.
- Monitoring.
- Backup validation.
- Deployment scripts.
- Operational runbooks.
- Error recovery tests.
- End-to-end regression tests.
- Accessibility checks.
- Final documentation review.

Prepare a pilot deployment checklist.

---

# 18. ACCEPTANCE CRITERIA

The application is not considered ready for real-world pilot use merely because it builds successfully.

The following must be demonstrated:

**Functional correctness**

A cashier can create a valid order, the kitchen receives it, stock is reserved or consumed according to the defined lifecycle, payment can be recorded, and reports reflect the completed transaction.

**Inventory integrity**

Simultaneous requests cannot consume or reserve stock beyond availability.

**Realtime consistency**

Authorized connected devices receive updates and recover authoritative state after reconnection.

**Offline behavior**

Previously loaded kitchen data remains accessible when offline, pending actions are distinguishable from confirmed actions, and conflicts are handled correctly.

**Financial integrity**

No duplicate payment effects, incorrect totals or unexplained reporting differences in the tested workflows.

**Security**

Cross-tenant access is prevented by backend enforcement.

**Operational stability**

Service restarts and retry scenarios do not silently lose accepted orders.

**User experience**

Major workflows are usable on appropriate screen sizes and accessibility checks pass for the intended operating environment.

**Deployment readiness**

The application has reproducible startup, migrations, documented configuration, tested backup/restore and monitoring.

If any acceptance criterion remains unverified, explicitly report it as unverified.

Do not fabricate passing results.

---

# 19. FINAL ENGINEERING RULES

Write maintainable, production-oriented code.

Use strong typing.

Prefer explicit business rules over implicit behavior.

Keep modules cohesive.

Avoid giant service classes and oversized React components.

Avoid unnecessary dependencies.

Do not create abstractions without a concrete use case.

Use transactional database operations for critical workflows.

Keep Redis and WebSocket infrastructure separate from authoritative business state.

Make integrations replaceable.

Make background tasks idempotent.

Preserve operational auditability.

Treat financial and stock data as business-critical.

Prefer simple solutions that are correct and observable over complicated solutions that are difficult to verify.

---

# 20. START EXECUTION NOW

Begin by inspecting the current repository.

Then:

1. Produce a concise architecture and implementation plan.
2. Create or update foundational project files.
3. Implement Phase 1 fully enough to run locally.
4. Run the application and automated checks.
5. Fix failures found during verification.
6. Continue through subsequent phases in dependency order when feasible.
7. Maintain accurate implementation status documentation throughout execution.

Do not stop after generating planning documents.

Do not respond only with code snippets or generic recommendations.

Actually implement the project in the working repository.

If execution limits prevent completing all phases, leave the repository in a verified runnable state, document the remaining work precisely, and report the next executable milestone.

At each milestone report:

- Files and modules implemented.
- Features completed.
- Commands actually executed.
- Tests actually run and their outcomes.
- Remaining issues.
- Next implementation milestone.

**Build OMNIHUB as a reliable operational product, with correctness, safety and usability as the foundation of every engineering decision.**