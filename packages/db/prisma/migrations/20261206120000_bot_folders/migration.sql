-- Additive: the previous release never reads this table.
-- CreateTable
CREATE TABLE "bot_folders" (
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_folders_pkey" PRIMARY KEY ("botId","userId")
);

-- CreateIndex
CREATE INDEX "bot_folders_deviceId_idx" ON "bot_folders"("deviceId");

-- CreateIndex
CREATE INDEX "bot_folders_spaceId_idx" ON "bot_folders"("spaceId");

-- AddForeignKey
ALTER TABLE "bot_folders" ADD CONSTRAINT "bot_folders_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_folders" ADD CONSTRAINT "bot_folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_folders" ADD CONSTRAINT "bot_folders_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_folders" ADD CONSTRAINT "bot_folders_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Same policies as semantic_memories, with the keyed bypass from 20261114120000_rls_bypass_key.
ALTER TABLE "bot_folders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_folders_tenant ON "bot_folders"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY bot_folders_system ON "bot_folders"
  USING ((SELECT app_rls_bypass()));
