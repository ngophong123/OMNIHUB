import { describe, expect, it } from 'vitest';
import { allowed, allocateVnd, businessDate, cashExpected, convertUnit, digest, hashPassword, totalDue, transition, verifyPassword } from '../../apps/api/src/domain';
import { cashSchema, commandSchema, orderSchema, kitchenReplaySchema } from '../../packages/contracts/src';
import { composeRecipe, normalizeRecipe, selectionPrice } from '../../apps/api/src/catalog-domain';
import { LabeledCardSandboxAdapter } from '../../apps/api/src/card-provider';

describe('domain policies', () => {
  it('hashes high entropy public capabilities and rejects client-submitted totals', () => {
    const capability = 'a'.repeat(64);
    expect(digest(capability)).not.toBe(capability);
    expect(digest(capability)).toHaveLength(64);
    expect(orderSchema.safeParse({ lines: [{ productId: '22222222-2222-4222-8222-222222222222', quantity: 1, note: 'No ice' }], total: 1 }).success).toBe(false);
    expect(orderSchema.safeParse({ lines: [{ productId: '22222222-2222-4222-8222-222222222222', quantity: 1, note: 'x'.repeat(251) }] }).success).toBe(false);
  });
  it('limits offline kitchen replay to scoped, versioned preparation transitions', () => {
    const command = { commandId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222', storeId: '33333333-3333-4333-8333-333333333333', userId: '44444444-4444-4444-8444-444444444444', deviceId: '55555555-5555-4555-8555-555555555555', sequence: 1, orderId: '66666666-6666-4666-8666-666666666666', itemId: '77777777-7777-4777-8777-777777777777', expectedVersion: 3, action: 'START', createdAt: '2026-10-22T00:00:00.000Z' };
    expect(kitchenReplaySchema.safeParse(command).success).toBe(true);
    expect(kitchenReplaySchema.safeParse({ ...command, action: 'HANDOFF' }).success).toBe(false);
    expect(kitchenReplaySchema.safeParse({ ...command, expectedVersion: -1 }).success).toBe(false);
    expect(kitchenReplaySchema.safeParse({ ...command, paymentStatus: 'PAID' }).success).toBe(false);
  });
  it('uses snapshot integer prices and excludes cancelled units', () => {
    expect(totalDue([{ unitPrice: 35000, status: 'HANDED_OFF' }, { unitPrice: 40000, status: 'CANCELLED' }])).toBe(35000);
    expect(() => totalDue([{ unitPrice: 1.1, status: 'PENDING' }])).toThrow('INVALID_MONEY');
    expect(() => totalDue([{ unitPrice: 1_000_000_001, status: 'PENDING' }])).toThrow('TOTAL_LIMIT');
  });
  it('reconciles integer VND using cash payments once and signed movements', () => {
    expect(cashExpected(10000, 35000, [{ kind: 'CASH_IN', amount: 5000 }, { kind: 'CASH_OUT', amount: 2000 }, { kind: 'REFUND', amount: 3000 }, { kind: 'CORRECTION_IN', amount: 1000 }])).toBe(46000);
    expect(() => cashExpected(0, 0, [{ kind: 'CASH_OUT', amount: 1 }])).toThrow('INVALID_EXPECTED_CASH');
    expect(() => cashExpected(0, 0, [{ kind: 'CASH_IN', amount: 0.5 }])).toThrow('INVALID_CASH_AMOUNT');
  });
  it('allocates integer VND splits exactly with deterministic remainder handling', () => {
    expect(allocateVnd(100, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }])).toEqual({ a: 34, b: 33, c: 33 });
    expect(Object.values(allocateVnd(35_000, [{ id: 'drink', weight: 20_000 }, { id: 'food', weight: 15_000 }])).reduce((sum, value) => sum + value, 0)).toBe(35_000);
    expect(() => allocateVnd(10, [{ id: 'same', weight: 1 }, { id: 'same', weight: 2 }])).toThrow('INVALID_ALLOCATION');
  });
  it('keeps card processing explicitly disabled until a provider is configured', async () => {
    const adapter = new LabeledCardSandboxAdapter();
    expect(adapter.name).toBe('SANDBOX_ONLY');
    expect(adapter.enabledForProduction).toBe(false);
    await expect(adapter.authorize(10_000)).rejects.toThrow('CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED');
  });
  it('keeps readiness separate from fulfillment and rejects skipped/repeated transitions', () => {
    expect(transition('PENDING', 'START')).toBe('PREPARING');
    expect(transition('PREPARING', 'READY')).toBe('READY');
    expect(transition('READY', 'HANDOFF')).toBe('HANDED_OFF');
    expect(transition('PENDING', 'READY')).toBeNull();
    expect(transition('PREPARING', 'START')).toBeNull();
    expect(transition('CANCELLED', 'CANCEL')).toBeNull();
  });
  it('enforces business-day cutoff at local 04:00 across month/year', () => {
    expect(businessDate(new Date('2026-10-20T20:59:59Z'), 240, 'Asia/Ho_Chi_Minh')).toBe('2026-10-20');
    expect(businessDate(new Date('2026-10-20T21:00:00Z'), 240, 'Asia/Ho_Chi_Minh')).toBe('2026-10-21');
    expect(businessDate(new Date('2025-12-31T20:59:59Z'), 240, 'Asia/Ho_Chi_Minh')).toBe('2025-12-31');
    expect(() => businessDate(new Date(), 240, 'America/New_York')).toThrow();
  });
  it('converts exact quantities without density assumptions or silent rounding', () => {
    expect(convertUnit('0.125', 'kg', 'g')).toBe('125.000');
    expect(convertUnit('125', 'g', 'kg')).toBe('0.125');
    expect(() => convertUnit('0.001', 'g', 'kg')).toThrow('PRECISION_LOSS');
    expect(() => convertUnit('1', 'ml', 'g')).toThrow('INCOMPATIBLE_UNITS');
  });
  it('normalizes recipe units to ingredient base units and rejects duplicate or incompatible lines', () => {
    const ingredients = [{ id: 'coffee', unit: 'g', active: true, deletedAt: null }];
    expect(normalizeRecipe([{ ingredientId: 'coffee', quantity: '0.025', unit: 'kg' }], ingredients)).toEqual([{ ingredientId: 'coffee', quantity: '25.000' }]);
    expect(() => normalizeRecipe([{ ingredientId: 'coffee', quantity: '1', unit: 'ml' }], ingredients)).toThrow('INCOMPATIBLE_UNITS');
    expect(() => normalizeRecipe([{ ingredientId: 'coffee', quantity: '1', unit: 'g' }, { ingredientId: 'coffee', quantity: '2', unit: 'g' }], ingredients)).toThrow('DUPLICATE_INGREDIENT');
  });
  it('composes variant and modifier recipes while preserving exact price arithmetic', () => {
    expect(composeRecipe([{ ingredientId: 'coffee', quantity: '20.000' }], '1.500', [{ ingredientId: 'milk', quantity: '25.000' }, { ingredientId: 'coffee', quantity: '2.000' }])).toEqual([{ ingredientId: 'coffee', quantity: '32.000' }, { ingredientId: 'milk', quantity: '25.000' }]);
    expect(selectionPrice(35000, 40000, [5000, 2500])).toBe(47500);
    expect(() => selectionPrice(1_000_000_000, undefined, [1])).toThrow('TOTAL_LIMIT');
  });
  it('limits financial and stock authority', () => {
    expect(allowed('KITCHEN', 'cash')).toBe(false);
    expect(allowed('CASHIER', 'cancelStarted')).toBe(false);
    expect(allowed('INVENTORY', 'inventory')).toBe(true);
    expect(allowed('MANAGER', 'cancelStarted')).toBe(true);
  });
  it('salts password hashes and verifies without cleartext storage', () => {
    const a = hashPassword('local-test-password'); const b = hashPassword('local-test-password');
    expect(a).not.toBe(b); expect(verifyPassword('local-test-password', a)).toBe(true); expect(verifyPassword('wrong', a)).toBe(false);
  });
  it('rejects frontend money injection and fractional/oversized input', () => {
    expect(orderSchema.safeParse({ lines: [{ productId: '00000000-0000-4000-8000-000000000001', quantity: 1 }], total: 0 }).success).toBe(false);
    expect(cashSchema.safeParse({ expectedVersion: 1, tendered: 0.01 }).success).toBe(false);
    expect(commandSchema.safeParse({ expectedVersion: -1, action: 'READY' }).success).toBe(false);
  });
});
