-- Teammates share a Space, so each person's idempotent creates (such as their first bot from
-- onboarding) need their own key. The old index stays unique for the previous release until
-- the new one exists.
CREATE UNIQUE INDEX "bots_spaceId_userId_spawnKey_key" ON "bots"("spaceId", "userId", "spawnKey");

DROP INDEX "bots_spaceId_spawnKey_key";
