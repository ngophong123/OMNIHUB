import { randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Context } from './auth';
import { digest } from './domain';
import { CommandBus, scope } from './commands';
import { CatalogOperations } from './catalog-operations';

const token = () => randomBytes(32).toString('hex');
const tableUnavailable = () => new NotFoundException('TABLE_QR_UNAVAILABLE');

export class QrOrdering extends CommandBus {
  private catalog: CatalogOperations;
  constructor(db: PrismaClient) { super(db); this.catalog = new CatalogOperations(db); }

  async listTables(ctx: Context) {
    return this.db.restaurantTable.findMany({ where: { ...scope(ctx) }, orderBy: [{ name: 'asc' }, { id: 'asc' }], include: { sessions: { where: { status: 'OPEN', expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, expiresAt: true, _count: { select: { orders: true } } } } } });
  }

  async createTable(ctx: Context, key: string, name: string) {
    const credential = token(); let exposedToken = '';
    const result = await this.command(ctx, key, 'table.changed', { action: 'create', name }, async tx => {
      const row = await tx.restaurantTable.create({ data: { ...scope(ctx), name, qrTokenHash: digest(credential) } });
      exposedToken = credential; return { id: row.id, version: row.version };
    }, 'catalog');
    if (!exposedToken) throw new ConflictException('QR_CREATED_RETRY_WITH_NEW_KEY');
    return { ...result, token: exposedToken };
  }

  async updateTable(ctx: Context, key: string, id: string, version: number, name: string, active: boolean, qrEnabled: boolean) {
    return this.command(ctx, key, 'table.changed', { action: 'update', id, version, name, active, qrEnabled }, async tx => {
      const row = await tx.restaurantTable.findFirst({ where: { ...scope(ctx), id } });
      if (!row) throw new NotFoundException('TABLE_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const updated = await tx.restaurantTable.update({ where: { id }, data: { name, active, qrEnabled, version: { increment: 1 } } });
      return { id, version: updated.version };
    }, 'catalog');
  }

  async regenerate(ctx: Context, key: string, id: string, version: number) {
    const credential = token(); let exposedToken = '';
    const result = await this.command(ctx, key, 'table.changed', { action: 'qr.regenerate', id, version }, async tx => {
      const row = await tx.restaurantTable.findFirst({ where: { ...scope(ctx), id } });
      if (!row) throw new NotFoundException('TABLE_NOT_FOUND');
      if (row.version !== version) throw new ConflictException('STALE_VERSION');
      const updated = await tx.restaurantTable.update({ where: { id }, data: { qrTokenHash: digest(credential), version: { increment: 1 } } });
      exposedToken = credential; return { id, version: updated.version };
    }, 'catalog');
    if (!exposedToken) throw new ConflictException('QR_ROTATED_RETRY_WITH_NEW_KEY');
    return { ...result, token: exposedToken };
  }

  async setStoreEnabled(ctx: Context, key: string, enabled: boolean) {
    return this.command(ctx, key, 'table.changed', { action: 'store.qr', enabled }, async tx => {
      const store = await tx.store.update({ where: { tenantId_id: { tenantId: ctx.tenantId, id: ctx.storeId } }, data: { qrOrderingEnabled: enabled } });
      return { id: store.id, version: 0 };
    }, 'catalog');
  }

  async closeTableSession(ctx: Context, key: string, id: string) {
    return this.command(ctx, key, 'table.session.closed', { id }, async tx => {
      const session = await tx.tableSession.findFirst({ where: { ...scope(ctx), id, status: 'OPEN' } });
      if (!session) throw new NotFoundException('TABLE_SESSION_NOT_FOUND');
      const updated = await tx.tableSession.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
      return { id, version: updated.id ? 1 : 0 };
    }, 'catalog');
  }

  private async resolveQr(raw: string) {
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw tableUnavailable();
    const table = await this.db.restaurantTable.findFirst({ where: { qrTokenHash: digest(raw), active: true, qrEnabled: true, store: { qrOrderingEnabled: true } }, include: { store: { include: { tenant: true } } } });
    if (!table) throw tableUnavailable();
    return table;
  }

  async publicMenu(raw: string) {
    const table = await this.resolveQr(raw);
    const context = { tenantId: table.tenantId, storeId: table.storeId, userId: table.id, role: 'CASHIER' as const, tokenHash: '', expiresAt: new Date(0), correlationId: '' };
    const products = await this.db.product.findMany({ where: { ...scope(context), active: true, deletedAt: null, station: { active: true, deletedAt: null }, OR: [{ categoryId: null }, { category: { active: true, deletedAt: null } }] }, include: { category: { select: { id: true, name: true } }, recipe: true, variants: { where: { active: true, deletedAt: null } }, modifierGroups: { where: { active: true, deletedAt: null }, include: { options: { where: { active: true, deletedAt: null }, include: { recipe: true } } } } }, orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }] });
    const base = await this.catalog.availability(context, products.map(p => ({ id: p.id, recipe: p.recipe })));
    const selectedRecipes = products.flatMap(p => [
      ...p.variants.map(v => ({ id: v.id, recipe: p.recipe.map(r => ({ ingredientId: r.ingredientId, quantity: r.quantity.mul(v.recipeMultiplier) })) })),
      ...p.modifierGroups.flatMap(g => g.options.map(o => ({ id: o.id, recipe: o.recipe }))),
    ]);
    const selectedStock = await this.catalog.availability(context, selectedRecipes);
    return {
      restaurant: { name: table.store.name }, table: { name: table.name },
      categories: [...new Map(products.filter(p => p.category).map(p => [p.category!.id, p.category!])).values()],
      products: products.map(p => ({ id: p.id, name: p.name, description: p.description, imageUrl: p.imageUrl, price: p.price, categoryId: p.categoryId, categoryName: p.category?.name, available: p.manualAvailable && (base.get(p.id) ?? false), variants: p.variants.map(v => ({ id: v.id, name: v.name, price: v.price, available: p.manualAvailable && (selectedStock.get(v.id) ?? false) })), modifierGroups: p.modifierGroups.map(g => ({ id: g.id, name: g.name, minSelections: g.minSelections, maxSelections: g.maxSelections, options: g.options.map(o => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, available: selectedStock.get(o.id) ?? false })) })) })),
    };
  }

  async openCustomerSession(rawQr: string) {
    const table = await this.resolveQr(rawQr);
    const sessionToken = token();
    const row = await this.db.tableSession.create({ data: { tenantId: table.tenantId, storeId: table.storeId, tableId: table.id, sessionTokenHash: digest(sessionToken), qrCredentialHash: table.qrTokenHash, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000) } });
    return { id: row.id, token: sessionToken, expiresAt: row.expiresAt };
  }

  async validateCustomerSession(raw: string) {
    if (!/^[a-f0-9]{64}$/i.test(raw)) throw new ForbiddenException('TABLE_SESSION_INVALID');
    const row = await this.db.tableSession.findFirst({ where: { sessionTokenHash: digest(raw), status: 'OPEN', expiresAt: { gt: new Date() }, table: { active: true, qrEnabled: true, qrTokenHash: { not: '' }, store: { qrOrderingEnabled: true } } }, include: { table: true, store: true } });
    if (!row || row.qrCredentialHash !== row.table.qrTokenHash) throw new ForbiddenException('TABLE_SESSION_EXPIRED_OR_REVOKED');
    return row;
  }

  async customerSession(raw: string) {
    const row = await this.validateCustomerSession(raw);
    return { id: row.id, expiresAt: row.expiresAt, restaurant: row.store.name, table: row.table.name };
  }

  async status(rawTrackingToken: string) {
    if (!/^[a-f0-9]{64}$/i.test(rawTrackingToken)) throw new NotFoundException('TRACKING_NOT_FOUND');
    const order = await this.db.order.findFirst({ where: { trackingTokenHash: digest(rawTrackingToken) }, include: { items: { select: { id: true, name: true, status: true } }, tableSession: { include: { table: { select: { name: true } } } }, store: { select: { name: true } } } });
    if (!order) throw new NotFoundException('TRACKING_NOT_FOUND');
    const active = order.items.filter(i => i.status !== 'CANCELLED');
    const status = order.status === 'CANCELLED' ? 'CANCELLED' : active.length > 0 && active.every(i => i.status === 'HANDED_OFF') ? 'SERVED' : active.length > 0 && active.every(i => i.status === 'READY' || i.status === 'HANDED_OFF') ? 'READY' : active.some(i => ['PREPARING','READY','HANDED_OFF'].includes(i.status)) ? 'PREPARING' : 'ACCEPTED';
    return { id: order.id, status, restaurant: order.store.name, table: order.tableSession?.table.name ?? null, createdAt: order.createdAt, items: order.items.map(i => ({ name: i.name, status: i.status })) };
  }
}
