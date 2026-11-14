# Domain model and invariants

Tenant owns stores. User has an explicit role membership at a store. Store holds timezone and business-day cutoff (MVP supports fixed UTC+07 Asia/Ho_Chi_Minh; other zones rejected until DST-safe support exists). Session stores only a hashed opaque random token. Disabled users and revoked memberships cannot operate even with an unexpired cookie.

Product belongs to a store and kitchen station, and may belong to a category. Recipe maps ingredients to decimal base-unit quantities; grams/kilograms and millilitres/litres convert exactly, without density assumptions or silent rounding. Recipe changes increment recipeVersion and append a RecipeRevision. Product variants use absolute VND prices and recipe multipliers; modifier/topping prices are non-negative deltas and their ingredient additions are composed with the base/variant recipe. Accepted OrderItem snapshots name, calculated integer unit price, selected variant/modifiers, recipe version and exact composed ingredient quantities. Later catalog edits never change existing order snapshots or reservations.

Order owns unit-level OrderItems and KitchenTickets. Each ticket belongs to one station. Units reference their ticket. Product quantity input expands into separate units to allow cancellation/preparation of individual portions. Ticket state is derived from its units; fulfilled/cancelled units are terminal.

InventoryBalance is per store and ingredient: onHand and reserved are Decimal(18,3). available = onHand - reserved. Constraints: onHand >= reserved >= 0. Reservation is per unit/ingredient and moves RESERVED -> CONSUMED or RELEASED exactly once. Movement is an append-only delta of onHand/reserved, with order/item/command or stock-receipt references and optional waste classification. Receipts and adjustments update balance and ledger in one transaction. WASTE changes classification only for already consumed ingredients. Ingredient units cannot change after use in recipes or stock movements; ingredients with stock or active recipe references cannot be archived.

Money is integer VND, bounded to safe JS integers and PostgreSQL integer limits. Product prices are <= 1 billion; accepted order total <= 1 billion. All sums validated server-side. Cash payment snapshots amount, tender and change; only one payment per order. Financial snapshots are not catalog lookups.

Composite tenant/store foreign keys enforce ownership of product, station, order, ingredient, reservation, ticket and ledger references. SQL CHECK constraints supplement ORM validation. Tenant/store IDs come from a verified session, never from command bodies.

Audit, outbox and command receipt commit in the same transaction as the mutation. Command receipt key is (tenant, store, key); payload hash includes actor, operation and validated payload. Same key with different content returns 409. Replays return original response and do not repeat side effects. Authorization is checked before replay.
