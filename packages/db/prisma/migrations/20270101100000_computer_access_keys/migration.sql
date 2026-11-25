-- Additive: the previous release never reads this table.
CREATE TABLE "computer_access_keys" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "allowCommands" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_access_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_access_keys_tokenDigest_key" ON "computer_access_keys"("tokenDigest");
CREATE INDEX "computer_access_keys_spaceId_botId_idx" ON "computer_access_keys"("spaceId", "botId");
CREATE INDEX "computer_access_keys_userId_idx" ON "computer_access_keys"("userId");

ALTER TABLE "computer_access_keys" ADD CONSTRAINT "computer_access_keys_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_access_keys" ADD CONSTRAINT "computer_access_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_access_keys" ADD CONSTRAINT "computer_access_keys_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as the other Space-owned tables, such as memory_documents.
ALTER TABLE "computer_access_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_access_keys_tenant ON "computer_access_keys"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY computer_access_keys_system ON "computer_access_keys"
  USING ((SELECT app_rls_bypass()));
