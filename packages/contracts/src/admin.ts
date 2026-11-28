import { z } from 'zod';
export const nameSchema = z.string().trim().min(1).max(120);
export const categoryNameSchema = z.object({ name: nameSchema }).strict();
export const quantitySchema = z.string().regex(/^\d+(\.\d{1,3})?$/).refine(v => Number(v) > 0 && Number(v) <= 1_000_000_000);
export const recipeLineSchema = z.object({ ingredientId: z.string().uuid(), quantity: quantitySchema, unit: z.enum(['g', 'kg', 'ml', 'l', 'piece']) }).strict();
export const recipeSchema = z.array(recipeLineSchema).max(100).refine(lines => new Set(lines.map(l => l.ingredientId)).size === lines.length, 'DUPLICATE_INGREDIENT');
export const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const entitySchema = z.object({ name: nameSchema, active: z.boolean() }).strict();
export const ingredientSchema = entitySchema.extend({ unit: z.enum(['g', 'ml', 'piece']), lowStockThreshold: z.string().regex(/^\d+(\.\d{1,3})?$/).refine(v => Number(v) <= 1_000_000_000) }).strict();
export const productSchema = entitySchema.extend({ description: z.string().trim().max(1000), imageUrl: z.string().url().max(1000).nullable().optional().refine(v => !v || new URL(v).protocol === 'https:', 'HTTPS_REQUIRED'), price: z.number().int().min(0).max(1_000_000_000), stationId: z.string().uuid(), categoryId: z.string().uuid().nullable(), manualAvailable: z.boolean(), recipe: recipeSchema.refine(v => v.length > 0) }).strict();
export const variantSchema = entitySchema.extend({ price: z.number().int().min(0).max(1_000_000_000), recipeMultiplier: quantitySchema.refine(v => Number(v) <= 1000) }).strict();
export const groupSchema = entitySchema.extend({ minSelections: z.number().int().min(0).max(20), maxSelections: z.number().int().min(1).max(20) }).strict().refine(group => group.minSelections <= group.maxSelections, 'INVALID_SELECTION_RANGE');
export const modifierSchema = entitySchema.extend({ priceDelta: z.number().int().min(0).max(1_000_000_000), recipe: recipeSchema.refine(v => v.length > 0) }).strict();
export const receiptSchema = z.object({ reference: z.string().trim().min(3).max(80), supplier: nameSchema, lines: recipeSchema.refine(v => v.length > 0) }).strict();
export const listSchema = z.object({
  q: z.string().trim().max(120).default(''), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['all', 'active', 'inactive', 'archived']).default('all'), categoryId: z.string().uuid().optional(), stationId: z.string().uuid().optional(), manualAvailable: z.enum(['true', 'false']).optional(),
}).strict();
export const categoryListSchema = z.object({ q: z.string().trim().max(120).default(''), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50), status: z.enum(['all', 'active', 'inactive']).default('all') }).strict();
export const movementListSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), ingredientId: z.string().uuid().optional(), kind: z.enum(['RESERVE', 'CONSUME', 'RELEASE', 'WASTE', 'ADJUST', 'RECEIPT']).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
export type RecipeInput = z.infer<typeof recipeSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type IngredientInput = z.infer<typeof ingredientSchema>;
export type VariantInput = z.infer<typeof variantSchema>;
export type GroupInput = z.infer<typeof groupSchema>;
export type ModifierInput = z.infer<typeof modifierSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type ListInput = z.output<typeof listSchema>;
export type CategoryListInput = z.output<typeof categoryListSchema>;
export type MovementListInput = z.output<typeof movementListSchema>;
