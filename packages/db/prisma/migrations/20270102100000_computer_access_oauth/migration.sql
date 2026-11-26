-- Additive: the previous release never reads these columns or this table.
ALTER TABLE "computer_access_keys" ADD COLUMN "controlLeaseId" TEXT;
ALTER TABLE "computer_access_keys" ADD COLUMN "windowStartedAt" TIMESTAMP(3);
ALTER TABLE "computer_access_keys" ADD COLUMN "windowCalls" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "computer_access_keys_controlLeaseId_idx" ON "computer_access_keys"("controlLeaseId");

CREATE TABLE "computer_access_codes" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowCommands" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_access_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_access_codes_codeDigest_key" ON "computer_access_codes"("codeDigest");
CREATE INDEX "computer_access_codes_userId_idx" ON "computer_access_codes"("userId");
CREATE INDEX "computer_access_codes_botId_idx" ON "computer_access_codes"("botId");

ALTER TABLE "computer_access_codes" ADD CONSTRAINT "computer_access_codes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_access_codes" ADD CONSTRAINT "computer_access_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_access_codes" ADD CONSTRAINT "computer_access_codes_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "computer_access_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_access_codes_tenant ON "computer_access_codes"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY computer_access_codes_system ON "computer_access_codes"
  USING ((SELECT app_rls_bypass()));
