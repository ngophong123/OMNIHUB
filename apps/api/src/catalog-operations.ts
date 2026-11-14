import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Context } from './auth';
import type { CategoryListInput, GroupInput, IngredientInput, ListInput, ModifierInput, ProductInput, ReceiptInput, VariantInput, MovementListInput } from '@omnihub/contracts';
import { CommandBus, scope, type Tx } from './commands';
import { composeRecipe, normalizeRecipe, type RecipeLine } from './catalog-domain';

const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });
function uniqueName(name: string, others: string[]) {
  return !others.some(other => other.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0);
}

export class CatalogOperations extends CommandBus {
  async categories(ctx: Context, filter: CategoryListInput) {
    const where: Prisma.CategoryWhereInput = { ...scope(ctx), deletedAt: null, ...(filter.status === 'active' ? { active: true } : filter.status === 'inactive' ? { active: false } : {}), ...(filter.q ? { name: contains(filter.q) } : {}) };
    const [total, rows] = await this.db.$transaction([this.db.category.count({ where }), this.db.category.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize, include: { _count: { select: { products: true } } } })]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize, pages: Math.ceil(total / filter.pageSize) };
  }
  async createCategory(ctx: Context, key: string, name: string) {
    return this.command(ctx, key, 'catalog.changed', { action: 'category.create', name }, async tx => {
      const peers = await tx.category.findMany({ where: scope(ctx), select: { name: true } });
      if (!uniqueName(name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const row = await tx.category.create({ data: { ...scope(ctx), name } });
      return { id: row.id, version: row.version };
    }, 'catalog');
  }
  async updateCategory(ctx: Context, key: string, id: string, version: number, name: string, active: boolean) {
    return this.command(ctx, key, 'catalog.changed', { action: 'category.update', id, version, name, active }, async tx => {
      const current = await tx.category.findFirst({ where: { ...scope(ctx), id, deletedAt: null } });
      if (!current) throw new NotFoundException('CATEGORY_NOT_FOUND');
      if (current.version !== version) throw new ConflictException('STALE_VERSION');
      if (current.active && !active && await tx.product.count({ where: { ...scope(ctx), categoryId: id, active: true, deletedAt: null } })) throw new ConflictException('CATEGORY_HAS_ACTIVE_PRODUCTS');
      const peers = await tx.category.findMany({ where: { ...scope(ctx), id: { not: id } }, select: { name: true } });
      if (!uniqueName(name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const row = await tx.category.update({ where: { id }, data: { name, active, version: { increment: 1 } } });
      return { id, version: row.version };
    }, 'catalog');
  }
  async archiveCategory(ctx: Context, key: string, id: string, version: number) {
    return this.command(ctx, key, 'catalog.changed', { action: 'category.archive', id, version }, async tx => {
      const row = await tx.category.findFirst({ where: { ...scope(ctx), id } });
      if (!row) throw new NotFoundException('CATEGORY_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      if (await tx.product.count({ where: { ...scope(ctx), categoryId: id, active: true, deletedAt: null } })) throw new ConflictException('CATEGORY_HAS_ACTIVE_PRODUCTS');
      const updated = await tx.category.update({ where: { id }, data: { active: false, deletedAt: new Date(), version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'catalog');
  }

  async stations(ctx: Context) { return this.db.station.findMany({ where: { ...scope(ctx), deletedAt: null }, orderBy: { name: 'asc' }, include: { _count: { select: { products: true, tickets: true } } } }); }
  async saveStation(ctx: Context, key: string, id: string | undefined, version: number | undefined, name: string, active: boolean) {
    return this.command(ctx, key, 'station.changed', { id: id ?? null, version: version ?? null, name, active }, async tx => {
      const peers = await tx.station.findMany({ where: { ...scope(ctx), deletedAt: null, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
      if (!uniqueName(name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      if (!id) { const row = await tx.station.create({ data: { ...scope(ctx), name, active } }); return { id: row.id, version: row.version }; }
      const current = await tx.station.findFirst({ where: { ...scope(ctx), id } });
      if (!current) throw new NotFoundException('STATION_NOT_FOUND');
      if (current.version !== version) throw new ConflictException('STALE_VERSION');
      if (current.active && !active && await tx.product.count({ where: { ...scope(ctx), stationId: id, active: true, deletedAt: null } })) throw new ConflictException('STATION_HAS_ACTIVE_PRODUCTS');
      const row = await tx.station.update({ where: { id }, data: { name, active, version: { increment: 1 } } });
      return { id, version: row.version };
    }, 'catalog');
  }
  async archiveStation(ctx: Context, key: string, id: string, version: number) {
    return this.command(ctx, key, 'station.changed', { action: 'station.archive', id, version }, async tx => {
      const current = await tx.station.findFirst({ where: { ...scope(ctx), id } });
      if (!current) throw new NotFoundException('STATION_NOT_FOUND');
      if (current.version !== version) throw new ConflictException('STALE_VERSION');
      if (await tx.product.count({ where: { ...scope(ctx), stationId: id, active: true, deletedAt: null } })) throw new ConflictException('STATION_HAS_ACTIVE_PRODUCTS');
      const row = await tx.station.update({ where: { id }, data: { active: false, deletedAt: new Date(), version: { increment: 1 } } });
      return { id, version: row.version };
    }, 'catalog');
  }

  async ingredients(ctx: Context) {
    return this.db.ingredient.findMany({ where: { ...scope(ctx), deletedAt: null }, orderBy: { name: 'asc' }, include: { balance: true, _count: { select: { recipeItems: true, modifierRecipes: true } } } });
  }
  async saveIngredient(ctx: Context, key: string, input: IngredientInput, id?: string, expectedVersion?: number) {
    return this.command(ctx, key, 'ingredient.changed', { id: id ?? null, expectedVersion: expectedVersion ?? null, ...input }, async tx => {
      const peers = await tx.ingredient.findMany({ where: { ...scope(ctx), deletedAt: null, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const threshold = new Prisma.Decimal(input.lowStockThreshold);
      if (!id) {
        const row = await tx.ingredient.create({ data: { ...scope(ctx), name: input.name, unit: input.unit, active: input.active, lowStockThreshold: threshold } });
        await tx.balance.create({ data: { ...scope(ctx), ingredientId: row.id } });
        return { id: row.id, version: row.version };
      }
      const current = await tx.ingredient.findFirst({ where: { ...scope(ctx), id } });
      if (!current || current.deletedAt) throw new NotFoundException('INGREDIENT_NOT_FOUND');
      if (current.version !== expectedVersion) throw new ConflictException('STALE_VERSION');
      if (!input.active) {
        const [usedByProducts, usedByModifiers] = await Promise.all([
          tx.recipeItem.count({ where: { ...scope(ctx), ingredientId: id, product: { active: true, deletedAt: null } } }),
          tx.modifierRecipeItem.count({ where: { ...scope(ctx), ingredientId: id, modifier: { active: true, deletedAt: null } } }),
        ]);
        if (usedByProducts || usedByModifiers) throw new ConflictException('INGREDIENT_USED_BY_ACTIVE_MENU');
      }
      if (current.unit !== input.unit) {
        const [moves, recipes, modifiers] = await Promise.all([
          tx.movement.count({ where: { ...scope(ctx), ingredientId: id } }), tx.recipeItem.count({ where: { ...scope(ctx), ingredientId: id } }), tx.modifierRecipeItem.count({ where: { ...scope(ctx), ingredientId: id } }),
        ]);
        if (moves || recipes || modifiers) throw new ConflictException('UNIT_IN_USE');
      }
      const row = await tx.ingredient.update({ where: { id }, data: { name: input.name, unit: input.unit, active: input.active, lowStockThreshold: threshold, version: { increment: 1 } } });
      return { id, version: row.version };
    }, 'inventory');
  }
  async archiveIngredient(ctx: Context, key: string, id: string, version: number) {
    return this.command(ctx, key, 'ingredient.changed', { action: 'ingredient.archive', id, version }, async tx => {
      const row = await tx.ingredient.findFirst({ where: { ...scope(ctx), id } });
      if (!row || row.deletedAt) throw new NotFoundException('INGREDIENT_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const [reserved, activeRecipes, modifierRecipes] = await Promise.all([
        tx.reservation.count({ where: { ...scope(ctx), ingredientId: id, status: 'RESERVED' } }),
        tx.recipeItem.count({ where: { ...scope(ctx), ingredientId: id, product: { active: true, deletedAt: null } } }),
        tx.modifierRecipeItem.count({ where: { ...scope(ctx), ingredientId: id, modifier: { active: true, deletedAt: null } } }),
      ]);
      if (reserved || activeRecipes || modifierRecipes) throw new ConflictException('INGREDIENT_USED_BY_ACTIVE_MENU_OR_ORDERS');
      const balance = await tx.balance.findUnique({ where: { tenantId_storeId_ingredientId: { ...scope(ctx), ingredientId: id } } });
      if (balance && (!balance.onHand.isZero() || !balance.reserved.isZero())) throw new ConflictException('INGREDIENT_HAS_STOCK');
      const updated = await tx.ingredient.update({ where: { id }, data: { active: false, deletedAt: new Date(), version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'inventory');
  }

  private async normalize(tx: Tx, ctx: Context, lines: ProductInput['recipe']): Promise<RecipeLine[]> {
    const ids = [...new Set(lines.map(l => l.ingredientId))];
    const ingredients = await tx.ingredient.findMany({ where: { ...scope(ctx), id: { in: ids }, active: true, deletedAt: null }, select: { id: true, unit: true, active: true, deletedAt: true } });
    try { return normalizeRecipe(lines, ingredients); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INVALID_RECIPE'); }
  }
  private async validateProductRelations(tx: Tx, ctx: Context, input: ProductInput) {
    const station = await tx.station.findFirst({ where: { ...scope(ctx), id: input.stationId, active: true, deletedAt: null } });
    if (!station) throw new BadRequestException('STATION_UNAVAILABLE');
    if (input.categoryId && !await tx.category.findFirst({ where: { ...scope(ctx), id: input.categoryId, active: true, deletedAt: null } })) throw new BadRequestException('CATEGORY_UNAVAILABLE');
    return this.normalize(tx, ctx, input.recipe);
  }
  async listProducts(ctx: Context, filter: ListInput) {
    const where: Prisma.ProductWhereInput = { ...scope(ctx), ...(filter.status === 'archived' ? { deletedAt: { not: null } } : { deletedAt: null }), ...(filter.status === 'active' ? { active: true } : filter.status === 'inactive' ? { active: false } : {}), ...(filter.categoryId ? { categoryId: filter.categoryId } : {}), ...(filter.stationId ? { stationId: filter.stationId } : {}), ...(filter.manualAvailable ? { manualAvailable: filter.manualAvailable === 'true' } : {}), ...(filter.q ? { OR: [{ name: contains(filter.q) }, { description: contains(filter.q) }] } : {}) };
    const [total, rows] = await this.db.$transaction([
      this.db.product.count({ where }), this.db.product.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize, include: { recipe: { include: { ingredient: { select: { name: true, unit: true } } } }, station: { select: { id: true, name: true, active: true } }, category: { select: { id: true, name: true } }, _count: { select: { variants: true, modifierGroups: true } } } }),
    ]);
    const availability = await this.availability(ctx, rows.map(p => ({ id: p.id, recipe: p.recipe })));
    return { rows: rows.map(p => ({ ...p, stockAvailable: availability.get(p.id) ?? false })), total, page: filter.page, pageSize: filter.pageSize, pages: Math.ceil(total / filter.pageSize) };
  }
  async createProduct(ctx: Context, key: string, input: ProductInput) {
    return this.command(ctx, key, 'catalog.changed', { action: 'product.create', ...input }, async tx => {
      const peers = await tx.product.findMany({ where: { ...scope(ctx), deletedAt: null }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const recipe = await this.validateProductRelations(tx, ctx, input);
      if (!recipe.length) throw new BadRequestException('RECIPE_REQUIRED');
      const row = await tx.product.create({ data: { ...scope(ctx), name: input.name, description: input.description, imageUrl: input.imageUrl ?? null, price: input.price, active: input.active, stationId: input.stationId, categoryId: input.categoryId, manualAvailable: input.manualAvailable } });
      await tx.recipeItem.createMany({ data: recipe.map(r => ({ ...scope(ctx), productId: row.id, ingredientId: r.ingredientId, quantity: r.quantity })) });
      await tx.recipeRevision.create({ data: { ...scope(ctx), productId: row.id, version: 1, lines: recipe as unknown as Prisma.InputJsonValue } });
      return { id: row.id, version: row.version };
    }, 'catalog');
  }
  async updateProduct(ctx: Context, key: string, id: string, version: number, input: ProductInput) {
    return this.command(ctx, key, 'recipe.changed', { action: 'product.update', id, version, ...input }, async tx => {
      const current = await tx.product.findFirst({ where: { ...scope(ctx), id, deletedAt: null }, include: { recipe: true } });
      if (!current) throw new NotFoundException('PRODUCT_NOT_FOUND');
      if (current.version !== version) throw new ConflictException('STALE_VERSION');
      const peers = await tx.product.findMany({ where: { ...scope(ctx), id: { not: id }, deletedAt: null }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const recipe = await this.validateProductRelations(tx, ctx, input);
      if (!recipe.length) throw new BadRequestException('RECIPE_REQUIRED');
      const nextRecipeVersion = current.recipeVersion + (current.recipe.length !== recipe.length || current.recipe.some(old => !recipe.some(next => next.ingredientId === old.ingredientId && new Prisma.Decimal(next.quantity).equals(old.quantity))) ? 1 : 0);
      const row = await tx.product.update({ where: { id }, data: { name: input.name, description: input.description, imageUrl: input.imageUrl ?? null, price: input.price, active: input.active, stationId: input.stationId, categoryId: input.categoryId, manualAvailable: input.manualAvailable, recipeVersion: nextRecipeVersion, version: { increment: 1 } } });
      if (nextRecipeVersion !== current.recipeVersion) {
        await tx.recipeItem.deleteMany({ where: { ...scope(ctx), productId: id } });
        await tx.recipeItem.createMany({ data: recipe.map(r => ({ ...scope(ctx), productId: id, ingredientId: r.ingredientId, quantity: r.quantity })) });
        await tx.recipeRevision.create({ data: { ...scope(ctx), productId: id, version: nextRecipeVersion, lines: recipe as unknown as Prisma.InputJsonValue } });
      }
      return { id, version: row.version };
    }, 'catalog');
  }
  async archiveProduct(ctx: Context, key: string, id: string, version: number) {
    return this.command(ctx, key, 'catalog.changed', { action: 'product.archive', id, version }, async tx => {
      const row = await tx.product.findFirst({ where: { ...scope(ctx), id, deletedAt: null } });
      if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const updated = await tx.product.update({ where: { id }, data: { active: false, manualAvailable: false, deletedAt: new Date(), version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'catalog');
  }
  async setAvailability(ctx: Context, key: string, id: string, version: number, available: boolean) {
    return this.command(ctx, key, 'catalog.changed', { action: 'product.availability', id, version, available }, async tx => {
      const product = await tx.product.findFirst({ where: { ...scope(ctx), id, deletedAt: null } });
      if (!product) throw new NotFoundException('PRODUCT_NOT_FOUND');
      if (product.version !== version) throw new ConflictException('STALE_VERSION');
      const row = await tx.product.update({ where: { id }, data: { manualAvailable: available, version: { increment: 1 } } });
      return { id, version: row.version };
    }, 'catalog');
  }
  async availability(ctx: Context, products: { id: string; recipe: { ingredientId: string; quantity: Prisma.Decimal.Value }[] }[]) {
    const ids = [...new Set(products.flatMap(p => p.recipe.map(r => r.ingredientId)))];
    const balances = await this.db.balance.findMany({ where: { ...scope(ctx), ingredientId: { in: ids } } });
    const byId = new Map(balances.map(b => [b.ingredientId, b]));
    return new Map(products.map(p => [p.id, p.recipe.length > 0 && p.recipe.every(r => { const b = byId.get(r.ingredientId); return !!b && b.onHand.sub(b.reserved).gte(r.quantity); })]));
  }

  async variants(ctx: Context, productId: string) {
    await this.productExists(ctx, productId);
    return this.db.productVariant.findMany({ where: { ...scope(ctx), productId, deletedAt: null }, orderBy: { name: 'asc' } });
  }
  async saveVariant(ctx: Context, key: string, productId: string, id: string | undefined, version: number | undefined, input: VariantInput) {
    return this.command(ctx, key, 'catalog.changed', { action: 'product.variant', productId, id: id ?? null, version: version ?? null, ...input }, async tx => {
      const product = await tx.product.findFirst({ where: { ...scope(ctx), id: productId, deletedAt: null }, include: { recipe: true } });
      if (!product) throw new NotFoundException('PRODUCT_NOT_FOUND');
      try { composeRecipe(product.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) })), input.recipeMultiplier, []); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INVALID_VARIANT_RECIPE'); }
      const peers = await tx.productVariant.findMany({ where: { ...scope(ctx), productId, deletedAt: null, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      if (!id) { const row = await tx.productVariant.create({ data: { ...scope(ctx), productId, name: input.name, active: input.active, price: input.price, recipeMultiplier: input.recipeMultiplier } }); return { id: row.id, version: row.version }; }
      const row = await tx.productVariant.findFirst({ where: { ...scope(ctx), productId, id, deletedAt: null } });
      if (!row) throw new NotFoundException('VARIANT_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const updated = await tx.productVariant.update({ where: { id }, data: { name: input.name, active: input.active, price: input.price, recipeMultiplier: input.recipeMultiplier, version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'catalog');
  }

  async groups(ctx: Context, productId: string) {
    await this.productExists(ctx, productId);
    return this.db.modifierGroup.findMany({ where: { ...scope(ctx), productId, deletedAt: null }, include: { options: { where: { deletedAt: null }, include: { recipe: { include: { ingredient: { select: { unit: true } } } } }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } });
  }
  async saveGroup(ctx: Context, key: string, productId: string, id: string | undefined, version: number | undefined, input: GroupInput) {
    if (input.minSelections > input.maxSelections) throw new BadRequestException('INVALID_SELECTION_RANGE');
    return this.command(ctx, key, 'catalog.changed', { action: 'modifier.group', productId, id: id ?? null, version: version ?? null, ...input }, async tx => {
      await this.productExistsTx(tx, ctx, productId);
      const peers = await tx.modifierGroup.findMany({ where: { ...scope(ctx), productId, deletedAt: null, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      if (!id) { const row = await tx.modifierGroup.create({ data: { ...scope(ctx), productId, name: input.name, active: input.active, minSelections: input.minSelections, maxSelections: input.maxSelections } }); return { id: row.id, version: row.version }; }
      const row = await tx.modifierGroup.findFirst({ where: { ...scope(ctx), productId, id, deletedAt: null } });
      if (!row) throw new NotFoundException('MODIFIER_GROUP_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const options = await tx.modifier.count({ where: { ...scope(ctx), groupId: id, active: true, deletedAt: null } });
      if (options < input.minSelections) throw new ConflictException('NOT_ENOUGH_ACTIVE_OPTIONS');
      const updated = await tx.modifierGroup.update({ where: { id }, data: { name: input.name, active: input.active, minSelections: input.minSelections, maxSelections: input.maxSelections, version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'catalog');
  }
  async saveModifier(ctx: Context, key: string, groupId: string, id: string | undefined, version: number | undefined, input: ModifierInput) {
    return this.command(ctx, key, 'catalog.changed', { action: 'modifier.option', groupId, id: id ?? null, version: version ?? null, ...input }, async tx => {
      const group = await tx.modifierGroup.findFirst({ where: { ...scope(ctx), id: groupId, active: true, deletedAt: null } });
      if (!group) throw new NotFoundException('MODIFIER_GROUP_NOT_FOUND');
      const peers = await tx.modifier.findMany({ where: { ...scope(ctx), groupId, deletedAt: null, ...(id ? { id: { not: id } } : {}) }, select: { name: true } });
      if (!uniqueName(input.name, peers.map(p => p.name))) throw new ConflictException('DUPLICATE_NAME');
      const recipe = await this.normalize(tx, ctx, input.recipe);
      const product = await tx.product.findFirst({ where: { ...scope(ctx), id: group.productId, deletedAt: null }, include: { recipe: true, variants: { where: { active: true, deletedAt: null } } } });
      if (!product) throw new NotFoundException('PRODUCT_NOT_FOUND');
      const baseRecipe = product.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) }));
      try { for (const multiplier of ['1', ...product.variants.map(v => v.recipeMultiplier.toFixed(3))]) composeRecipe(baseRecipe, multiplier, recipe); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INVALID_MODIFIER_RECIPE'); }
      if (!id) {
        const row = await tx.modifier.create({ data: {
          ...scope(ctx), groupId, name: input.name, active: input.active, priceDelta: input.priceDelta,
        } });
        await tx.modifierRecipeItem.createMany({ data: recipe.map(r => ({ ...scope(ctx), modifierId: row.id, ingredientId: r.ingredientId, quantity: r.quantity })) });
        return { id: row.id, version: row.version };
      }
      const row = await tx.modifier.findFirst({ where: { ...scope(ctx), groupId, id, deletedAt: null }, include: { recipe: true } });
      if (!row) throw new NotFoundException('MODIFIER_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const updated = await tx.modifier.update({ where: { id }, data: { name: input.name, active: input.active, priceDelta: input.priceDelta, version: { increment: 1 } } });
      await tx.modifierRecipeItem.deleteMany({ where: { ...scope(ctx), modifierId: id } });
      await tx.modifierRecipeItem.createMany({ data: recipe.map(r => ({ ...scope(ctx), modifierId: id, ingredientId: r.ingredientId, quantity: r.quantity })) });
      return { id, version: updated.version };
    }, 'catalog');
  }

  async receipt(ctx: Context, key: string, input: ReceiptInput) {
    return this.command(ctx, key, 'inventory.received', input, async tx => {
      const normalized = await this.normalize(tx, ctx, input.lines);
      if (!normalized.length) throw new BadRequestException('RECEIPT_LINES_REQUIRED');
      for (const line of normalized) {
        const quantity = new Prisma.Decimal(line.quantity);
        const changed = await tx.$executeRaw`UPDATE "Balance" SET "onHand" = "onHand" + ${quantity}::numeric WHERE "tenantId" = ${ctx.tenantId}::uuid AND "storeId" = ${ctx.storeId}::uuid AND "ingredientId" = ${line.ingredientId}::uuid`;
        if (changed !== 1) throw new ConflictException('BALANCE_NOT_FOUND');
      }
      const receipt = await tx.stockReceipt.create({ data: { ...scope(ctx), reference: input.reference, supplier: input.supplier, actorId: ctx.userId, lines: normalized as unknown as Prisma.InputJsonValue } });
      await tx.movement.createMany({ data: normalized.map(line => ({ ...scope(ctx), ingredientId: line.ingredientId, receiptId: receipt.id, commandKey: key, kind: 'RECEIPT', onHandDelta: line.quantity, reservedDelta: 0 })) });
      return { id: receipt.id, version: 1 };
    }, 'inventory');
  }
  async movements(ctx: Context, filter: MovementListInput) {
    if (filter.from && filter.to && new Date(filter.from) >= new Date(filter.to)) throw new BadRequestException('INVALID_DATE_RANGE');
    const where = { ...scope(ctx), ...(filter.ingredientId ? { ingredientId: filter.ingredientId } : {}), ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lt: new Date(filter.to) } : {}) } } : {}) };
    const [total, rows] = await this.db.$transaction([this.db.movement.count({ where }), this.db.movement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize, include: { ingredient: { select: { name: true, unit: true } } } })]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize, pages: Math.ceil(total / filter.pageSize) };
  }

  async productExists(ctx: Context, id: string) { const row = await this.db.product.findFirst({ where: { ...scope(ctx), id, deletedAt: null } }); if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND'); return row; }
  private async productExistsTx(tx: Tx, ctx: Context, id: string) { const row = await tx.product.findFirst({ where: { ...scope(ctx), id, deletedAt: null } }); if (!row) throw new NotFoundException('PRODUCT_NOT_FOUND'); return row; }
}
