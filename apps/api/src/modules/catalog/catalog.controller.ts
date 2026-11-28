import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import {
  categoryListSchema,
  categoryNameSchema,
  entitySchema,
  groupSchema,
  ingredientSchema,
  listSchema,
  modifierSchema,
  productSchema,
  variantSchema,
  versionSchema,
} from '@omnihub/contracts';
import { composeRecipe } from '../../catalog-domain';
import { CatalogOperations } from '../../catalog-operations';
import { allowed } from '../../domain';
import { PRISMA_DB } from '../../shared/database.module';
import { authenticateRequest, idempotencyKey, parseInput, parseUuid } from '../../shared/http-helpers';

@Controller()
export class CatalogController {
  constructor(
    @Inject(PRISMA_DB) private readonly db: PrismaClient,
    @Inject(CatalogOperations) private readonly catalog: CatalogOperations,
  ) {}

  @Get('catalog')
  async publicStaffCatalog(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    const rows = await this.db.product.findMany({
      where: {
        tenantId: c.tenantId,
        storeId: c.storeId,
        active: true,
        deletedAt: null,
        station: { active: true, deletedAt: null },
        OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }],
      },
      include: {
        recipe: true,
        variants: { where: { active: true, deletedAt: null } },
        modifierGroups: {
          where: { active: true, deletedAt: null },
          include: { options: { where: { active: true, deletedAt: null }, include: { recipe: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });
    const availability = await this.catalog.availability(
      c,
      rows.map(p => ({ id: p.id, recipe: p.recipe })),
    );
    const composableVariants: { id: string; recipe: { ingredientId: string; quantity: string }[] }[] = [];
    for (const p of rows) {
      const base = p.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.toFixed(3) }));
      for (const v of p.variants) {
        try {
          composableVariants.push({ id: v.id, recipe: composeRecipe(base, v.recipeMultiplier.toFixed(3), []) });
        } catch {
          // Guard read path against any legacy invalid multiplier; write path rejects invalid combinations.
        }
      }
    }
    const variantAvailability = await this.catalog.availability(c, composableVariants);
    return rows.map(p => ({
      ...p,
      variants: p.variants.map(v => ({ ...v, available: variantAvailability.get(v.id) ?? false })),
      stockAvailable: availability.get(p.id) ?? false,
      available: p.manualAvailable && (availability.get(p.id) ?? false) && p.recipe.length > 0,
    }));
  }

  @Get('admin/categories')
  async categories(@Req() req: Request, @Query() query: unknown) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.categories(c, parseInput(categoryListSchema, query));
  }

  @Post('admin/categories')
  async createCategory(@Req() req: Request, @Body() body: unknown) {
    return this.catalog.createCategory(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(categoryNameSchema, body).name,
    );
  }

  @Put('admin/categories/:id')
  async updateCategory(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(
      categoryNameSchema.extend({ ...versionSchema.shape, active: entitySchema.shape.active }),
      body,
    );
    return this.catalog.updateCategory(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      input.expectedVersion,
      input.name,
      input.active,
    );
  }

  @Delete('admin/categories/:id')
  async archiveCategory(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.archiveCategory(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(versionSchema, body).expectedVersion,
    );
  }

  @Get('admin/stations')
  async stations(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.stations(c);
  }

  @Post('admin/stations')
  async createStation(@Req() req: Request, @Body() body: unknown) {
    const input = parseInput(entitySchema, body);
    return this.catalog.saveStation(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      undefined,
      undefined,
      input.name,
      input.active,
    );
  }

  @Put('admin/stations/:id')
  async updateStation(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(entitySchema.extend(versionSchema.shape), body);
    return this.catalog.saveStation(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      input.expectedVersion,
      input.name,
      input.active,
    );
  }

  @Delete('admin/stations/:id')
  async archiveStation(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.archiveStation(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(versionSchema, body).expectedVersion,
    );
  }

  @Get('admin/ingredients')
  async ingredients(@Req() req: Request) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'inventory') && !allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.ingredients(c);
  }

  @Post('admin/ingredients')
  async createIngredient(@Req() req: Request, @Body() body: unknown) {
    return this.catalog.saveIngredient(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(ingredientSchema, body),
    );
  }

  @Put('admin/ingredients/:id')
  async updateIngredient(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(ingredientSchema.extend(versionSchema.shape), body);
    return this.catalog.saveIngredient(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      input,
      parseUuid(id),
      input.expectedVersion,
    );
  }

  @Delete('admin/ingredients/:id')
  async archiveIngredient(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.archiveIngredient(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(versionSchema, body).expectedVersion,
    );
  }

  @Get('admin/products')
  async listProducts(@Req() req: Request, @Query() query: unknown) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.listProducts(c, parseInput(listSchema, query));
  }

  @Post('admin/products')
  async createProduct(@Req() req: Request, @Body() body: unknown) {
    return this.catalog.createProduct(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseInput(productSchema, body),
    );
  }

  @Put('admin/products/:id')
  async updateProduct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(productSchema.extend(versionSchema.shape), body);
    return this.catalog.updateProduct(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      input.expectedVersion,
      input,
    );
  }

  @Delete('admin/products/:id')
  async archiveProduct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.archiveProduct(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      parseInput(versionSchema, body).expectedVersion,
    );
  }

  @Post('admin/products/:id/availability')
  async setAvailability(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(versionSchema.extend({ available: entitySchema.shape.active }), body);
    return this.catalog.setAvailability(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      input.expectedVersion,
      input.available,
    );
  }

  @Get('admin/products/:id/variants')
  async variants(@Req() req: Request, @Param('id') id: string) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.variants(c, parseUuid(id));
  }

  @Post('admin/products/:id/variants')
  async createVariant(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(variantSchema, body);
    return this.catalog.saveVariant(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      undefined,
      undefined,
      input,
    );
  }

  @Put('admin/products/:productId/variants/:id')
  async updateVariant(
    @Req() req: Request,
    @Param('productId') productId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(variantSchema.extend(versionSchema.shape), body);
    return this.catalog.saveVariant(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(productId),
      parseUuid(id),
      input.expectedVersion,
      input,
    );
  }

  @Get('admin/products/:id/modifier-groups')
  async groups(@Req() req: Request, @Param('id') id: string) {
    const c = await authenticateRequest(this.db, req);
    if (!allowed(c.role, 'catalog')) throw new ForbiddenException('PERMISSION_DENIED');
    return this.catalog.groups(c, parseUuid(id));
  }

  @Post('admin/products/:id/modifier-groups')
  async createGroup(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveGroup(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      undefined,
      undefined,
      parseInput(groupSchema, body),
    );
  }

  @Put('admin/products/:productId/modifier-groups/:id')
  async updateGroup(
    @Req() req: Request,
    @Param('productId') productId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(groupSchema.extend(versionSchema.shape), body);
    return this.catalog.saveGroup(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(productId),
      parseUuid(id),
      input.expectedVersion,
      input,
    );
  }

  @Post('admin/modifier-groups/:id/options')
  async createModifier(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveModifier(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(id),
      undefined,
      undefined,
      parseInput(modifierSchema, body),
    );
  }

  @Put('admin/modifier-groups/:groupId/options/:id')
  async updateModifier(
    @Req() req: Request,
    @Param('groupId') groupId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(modifierSchema.extend(versionSchema.shape), body);
    return this.catalog.saveModifier(
      await authenticateRequest(this.db, req),
      idempotencyKey(req),
      parseUuid(groupId),
      parseUuid(id),
      input.expectedVersion,
      input,
    );
  }
}
