import { z } from 'zod';
export * from './admin';

export const roles = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY'] as const;
export type Role = (typeof roles)[number];
export const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128), storeId: z.string().uuid() }).strict();
export const orderSchema = z.object({
  lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100), variantId: z.string().uuid().optional(), modifierIds: z.array(z.string().uuid()).max(20).optional(), note: z.string().trim().max(250).optional() }).strict()).min(1).max(50),
}).strict();
export const commandSchema = z.object({ expectedVersion: z.number().int().min(0), action: z.enum(['START', 'READY', 'HANDOFF', 'CANCEL']) }).strict();
export const kitchenDeviceSchema = z.object({ deviceId: z.string().uuid() }).strict();
export const kitchenDeviceAssignmentSchema = z.object({ stationId: z.string().uuid().nullable() }).strict();
export const invitationCreateSchema = z.object({ email: z.string().email().max(254), role: z.enum(['MANAGER', 'CASHIER', 'KITCHEN', 'INVENTORY']) }).strict();
export const invitationAcceptSchema = z.object({ password: z.string().min(12).max(128) }).strict();
export const kitchenReplaySchema = z.object({
  commandId: z.string().uuid(), tenantId: z.string().uuid(), storeId: z.string().uuid(), userId: z.string().uuid(), deviceId: z.string().uuid(),
  sequence: z.number().int().positive(), orderId: z.string().uuid(), itemId: z.string().uuid(),
  expectedVersion: z.number().int().min(1), action: z.enum(['START', 'READY']), createdAt: z.string().datetime(),
}).strict();
export const kitchenSyncSchema = z.object({ commands: z.array(kitchenReplaySchema).max(50) }).strict();
export const orderCancelSchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(5).max(300) }).strict();
export const cashSchema = z.object({ expectedVersion: z.number().int().min(0), tendered: z.number().int().min(0).max(1_000_000_000) }).strict();
export const paymentSchema = z.object({ amount: z.number().int().min(1).max(1_000_000_000), method: z.enum(['CASH','BANK_TRANSFER','CARD']), tendered: z.number().int().min(1).max(1_000_000_000).optional(), externalReference: z.string().trim().min(3).max(120).optional(), splitId: z.string().uuid().optional() }).strict();
export const refundRequestSchema = z.object({ amount: z.number().int().min(1).max(1_000_000_000), reason: z.string().trim().min(5).max(300), itemId: z.string().uuid().optional() }).strict();
export const refundDecisionSchema = z.object({ reason: z.string().trim().min(5).max(300), decision: z.enum(['APPROVED','REJECTED']) }).strict();
export const paymentFailureSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const billSplitSchema = z.object({ label: z.string().trim().min(1).max(80), amount: z.number().int().min(1).max(1_000_000_000).optional(), itemIds: z.array(z.string().uuid()).min(1).max(100).optional() }).strict().refine(x => Boolean(x.amount) !== Boolean(x.itemIds?.length), 'Specify amount or items');
export const cashShiftOpenSchema = z.object({ registerId: z.string().uuid(), cashierId: z.string().uuid().optional(), openingAmount: z.number().int().min(0).max(1_000_000_000) }).strict();
export const cashRegisterSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const cashShiftCloseSchema = z.object({ expectedVersion: z.number().int().min(1), countedAmount: z.number().int().min(0).max(1_000_000_000), reason: z.string().trim().max(300).optional() }).strict();
export const cashMovementSchema = z.object({ shiftId: z.string().uuid(), kind: z.enum(['CASH_IN','CASH_OUT','REFUND','CORRECTION_IN','CORRECTION_OUT']), amount: z.number().int().min(1).max(1_000_000_000), reason: z.string().trim().min(5).max(300), paymentId: z.string().uuid().optional() }).strict();
export const cashApprovalSchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(5).max(300) }).strict();
export const stockSchema = z.object({ ingredientId: z.string().uuid(), delta: z.string().regex(/^-?\d+(\.\d{1,3})?$/), reason: z.string().trim().min(5).max(300) }).strict();
export type CreateOrder = z.infer<typeof orderSchema>;
export type ItemCommand = z.infer<typeof commandSchema>;
export type CashCommand = z.infer<typeof cashSchema>;
export type CashShiftOpen = z.infer<typeof cashShiftOpenSchema>;
export type CashRegisterInput = z.infer<typeof cashRegisterSchema>;
export type CashShiftClose = z.infer<typeof cashShiftCloseSchema>;
export type CashMovementCommand = z.infer<typeof cashMovementSchema>;
export type StockCommand = z.infer<typeof stockSchema>;
export const eventTypes = ['order.accepted', 'order.cancelled', 'kitchen.item.started', 'kitchen.item.ready', 'kitchen.item.handed_off', 'order.item.cancelled', 'payment.confirmed', 'payment.recorded', 'payment.verified', 'payment.failed', 'refund.requested', 'refund.decided', 'payment.split.created', 'inventory.adjusted', 'catalog.changed', 'recipe.changed', 'ingredient.changed', 'station.changed', 'inventory.received', 'cash.shift.opened', 'cash.shift.closing', 'cash.shift.closed', 'cash.movement.recorded', 'cash.shift.approved', 'cash.register.changed', 'table.changed', 'table.session.closed'] as const;
export type EventType = (typeof eventTypes)[number];
export const eventSchema = z.object({
  eventId: z.string().uuid(), schemaVersion: z.literal(1), tenantId: z.string().uuid(), storeId: z.string().uuid(),
  type: z.enum(eventTypes), aggregateId: z.string().uuid(), version: z.number().int(), occurredAt: z.string().datetime(),
});
export type OperationalEvent = z.infer<typeof eventSchema>;
