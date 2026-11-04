-- A person's own network for their computers' browsers, one per person and Space.
CREATE TABLE "computer_network_exits" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "settings" JSONB NOT NULL,
  "secretId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "computer_network_exits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "computer_network_exits_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "computer_network_exits_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "computer_network_exits_secretId_fkey" FOREIGN KEY ("secretId")
    REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "computer_network_exits_secretId_key" ON "computer_network_exits"("secretId");
CREATE UNIQUE INDEX "computer_network_exits_spaceId_userId_key"
  ON "computer_network_exits"("spaceId", "userId");
CREATE INDEX "computer_network_exits_userId_idx" ON "computer_network_exits"("userId");

ALTER TABLE "computer_network_exits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_network_exits_tenant ON "computer_network_exits"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY computer_network_exits_system ON "computer_network_exits"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "computer_network_exits" TO rakazo_app;
