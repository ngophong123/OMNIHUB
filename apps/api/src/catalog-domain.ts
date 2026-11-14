import { Prisma } from '@prisma/client';
import { convertUnit } from './domain';

export type RecipeLine = { ingredientId: string; quantity: string };
export function normalizeRecipe(lines: { ingredientId: string; quantity: string; unit: string }[], ingredients: { id: string; unit: string; active: boolean; deletedAt: Date | null }[]): RecipeLine[] {
  if (new Set(lines.map(l => l.ingredientId)).size !== lines.length) throw new Error('DUPLICATE_INGREDIENT');
  return lines.map(line => {
    const i = ingredients.find(i => i.id === line.ingredientId);
    if (!i || !i.active || i.deletedAt) throw new Error('INGREDIENT_UNAVAILABLE');
    const quantity = convertUnit(line.quantity, line.unit, i.unit);
    if (new Prisma.Decimal(quantity).lte(0) || new Prisma.Decimal(quantity).gt('1000000000')) throw new Error('INVALID_QUANTITY');
    return { ingredientId: i.id, quantity };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
}
export function composeRecipe(base: RecipeLine[], multiplier: string, additions: RecipeLine[]): RecipeLine[] {
  const factor = new Prisma.Decimal(multiplier);
  if (!factor.isPositive() || factor.gt(1000)) throw new Error('INVALID_MULTIPLIER');
  const result = new Map<string, Prisma.Decimal>();
  for (const line of base) result.set(line.ingredientId, (result.get(line.ingredientId) ?? new Prisma.Decimal(0)).add(new Prisma.Decimal(line.quantity).mul(factor)));
  for (const line of additions) result.set(line.ingredientId, (result.get(line.ingredientId) ?? new Prisma.Decimal(0)).add(line.quantity));
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([ingredientId, quantity]) => {
    if (quantity.decimalPlaces() > 3 || !quantity.isPositive() || quantity.gt('1000000000')) throw new Error('RECIPE_PRECISION_OR_RANGE');
    return { ingredientId, quantity: quantity.toFixed(3) };
  });
}
export function selectionPrice(base: number, variant: number | undefined, modifiers: number[]): number {
  const values = [variant ?? base, ...modifiers];
  if (values.some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error('INVALID_MONEY');
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000) throw new Error('TOTAL_LIMIT');
  return total;
}
