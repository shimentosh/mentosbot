-- Additive: the previous release never reads this table.
CREATE TABLE "semantic_memories" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semantic_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "semantic_memories_spaceId_userId_botId_idx" ON "semantic_memories"("spaceId", "userId", "botId");

CREATE INDEX "semantic_memories_spaceId_userId_shared_idx" ON "semantic_memories"("spaceId", "userId", "shared");

ALTER TABLE "semantic_memories" ADD CONSTRAINT "semantic_memories_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "semantic_memories" ADD CONSTRAINT "semantic_memories_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as memory_documents, with the keyed bypass from 20261114120000_rls_bypass_key.
ALTER TABLE "semantic_memories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_memories_tenant ON "semantic_memories"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_memories_system ON "semantic_memories"
  USING ((SELECT app_rls_bypass()));
