ALTER TABLE "KitchenDevice" ADD COLUMN "stationId" UUID;

ALTER TABLE "KitchenDevice"
  ADD CONSTRAINT "KitchenDevice_tenantId_storeId_stationId_fkey"
  FOREIGN KEY ("tenantId", "storeId", "stationId")
  REFERENCES "Station"("tenantId", "storeId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "KitchenDevice_tenantId_storeId_stationId_revokedAt_idx"
  ON "KitchenDevice"("tenantId", "storeId", "stationId", "revokedAt");

CREATE TABLE "StoreInvitation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "invitedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "StoreInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreInvitation_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "StoreInvitation_tenantId_storeId_id_key" UNIQUE ("tenantId", "storeId", "id"),
  CONSTRAINT "StoreInvitation_role_check" CHECK ("role" <> 'OWNER'::"Role"),
  CONSTRAINT "StoreInvitation_terminal_state_check" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT "StoreInvitation_tenantId_storeId_fkey" FOREIGN KEY ("tenantId", "storeId")
    REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StoreInvitation_invitedBy_fkey" FOREIGN KEY ("invitedBy")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "StoreInvitation_tenantId_storeId_createdAt_idx"
  ON "StoreInvitation"("tenantId", "storeId", "createdAt");
CREATE INDEX "StoreInvitation_tenantId_storeId_email_expiresAt_idx"
  ON "StoreInvitation"("tenantId", "storeId", "email", "expiresAt");
