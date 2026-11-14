-- Seed immutable version-one revisions from the exact recipes already in use.
-- This gives existing products the same historical baseline as products created by admin APIs.
INSERT INTO "RecipeRevision" ("id", "tenantId", "storeId", "productId", "version", "lines", "createdAt")
SELECT gen_random_uuid(), p."tenantId", p."storeId", p."id", p."recipeVersion",
       COALESCE(jsonb_agg(jsonb_build_object('ingredientId', r."ingredientId", 'quantity', r."quantity") ORDER BY r."ingredientId") FILTER (WHERE r."ingredientId" IS NOT NULL), '[]'::jsonb),
       CURRENT_TIMESTAMP
FROM "Product" p
LEFT JOIN "RecipeItem" r ON r."tenantId" = p."tenantId" AND r."storeId" = p."storeId" AND r."productId" = p."id"
WHERE NOT EXISTS (
  SELECT 1 FROM "RecipeRevision" rr WHERE rr."productId" = p."id" AND rr."version" = p."recipeVersion"
)
GROUP BY p."tenantId", p."storeId", p."id", p."recipeVersion";
