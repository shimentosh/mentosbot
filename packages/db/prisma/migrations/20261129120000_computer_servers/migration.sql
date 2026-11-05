-- The deployment's own servers for bots' computers.
CREATE TABLE "computer_servers" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL DEFAULT '',
  "sshHost" TEXT,
  "sshUser" TEXT,
  "setupState" TEXT,
  "setupError" TEXT,
  "setupStartedAt" TIMESTAMP(3),
  "maxComputers" INTEGER NOT NULL,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "ready" BOOLEAN NOT NULL DEFAULT false,
  "secretId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "computer_servers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "computer_servers_secretId_fkey" FOREIGN KEY ("secretId")
    REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "computer_servers_secretId_key" ON "computer_servers"("secretId");

-- Read and written only by system code; deployment admins manage it through the API.
ALTER TABLE "computer_servers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_servers_system ON "computer_servers"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "computer_servers" TO rakazo_app;
