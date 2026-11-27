-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction. One chat per
-- teammate and shared bot.
CREATE UNIQUE INDEX CONCURRENTLY "threads_memberBotId_userId_key" ON "threads" ("memberBotId", "userId");
