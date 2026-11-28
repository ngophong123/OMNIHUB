import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../apps/api/src/domain';

const db = new PrismaClient();
async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is forbidden when NODE_ENV=production.');
  if (process.env.SEED_DEMO !== 'true' || !process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 12) throw new Error('Set SEED_DEMO=true and a DEMO_PASSWORD of at least 12 characters. Local fixtures only.');
  const tenantId = '11111111-1111-4111-8111-111111111111'; const storeId = '22222222-2222-4222-8222-222222222222';
  if (await db.tenant.findUnique({ where: { id: tenantId } })) { console.log('Demo tenant already exists; seed makes no changes.'); return; }
  const passwordHash = hashPassword(process.env.DEMO_PASSWORD);
  await db.$transaction(async tx => {
    await tx.tenant.create({ data: { id: tenantId, name: 'OMNIHUB Local Demo' } });
    await tx.store.create({ data: { id: storeId, tenantId, name: 'Bếp Nhà · Local' } });
    for (const role of ['OWNER', 'CASHIER', 'KITCHEN', 'INVENTORY'] as const) {
      const user = await tx.user.create({ data: { email: `${role.toLowerCase()}@local.omnihub.test`, passwordHash } });
      await tx.membership.create({ data: { userId: user.id, storeId, tenantId, role } });
    }
    const station = await tx.station.create({ data: { tenantId, storeId, name: 'Bếp chính' } });
    const ingredients = [];
    for (const [name, unit, quantity] of [['Cà phê', 'g', '5000'], ['Sữa', 'ml', '10000'], ['Trà', 'g', '3000']] as const) {
      const ingredient = await tx.ingredient.create({ data: { tenantId, storeId, name, unit } }); ingredients.push(ingredient);
      await tx.balance.create({ data: { tenantId, storeId, ingredientId: ingredient.id, onHand: quantity } });
      await tx.movement.create({ data: { tenantId, storeId, ingredientId: ingredient.id, commandKey: 'local-seed', kind: 'ADJUST', reason: 'Explicit local opening stock', onHandDelta: quantity, reservedDelta: 0 } });
    }
    const [coffee, milk, tea] = ingredients;
    if (!coffee || !milk || !tea) throw new Error('Seed ingredients missing');
    for (const [name, price, recipe] of [
      ['Cà phê đen', 30000, [{ ingredientId: coffee.id, quantity: '20' }]],
      ['Cà phê sữa', 35000, [{ ingredientId: coffee.id, quantity: '20' }, { ingredientId: milk.id, quantity: '50' }]],
      ['Trà sữa', 40000, [{ ingredientId: tea.id, quantity: '10' }, { ingredientId: milk.id, quantity: '100' }]],
    ] as const) {
      const p = await tx.product.create({ data: { tenantId, storeId, stationId: station.id, name, price } });
      for (const r of recipe) await tx.recipeItem.create({ data: { tenantId, storeId, productId: p.id, ...r } });
    }
  });
  console.log(`Local fixture ready. Store ID: ${storeId}; owner@local.omnihub.test. Password supplied via environment; never printed.`);
}
void seed().finally(() => db.$disconnect());
