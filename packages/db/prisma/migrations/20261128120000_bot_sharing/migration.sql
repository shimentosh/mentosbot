-- Sharing a bot with teammates: who may use it, and who wrote each message in its chat.
CREATE TABLE "bot_access" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "grantedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bot_access_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bot_access_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bot_access_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bot_access_botId_userId_key" ON "bot_access"("botId", "userId");
CREATE INDEX "bot_access_userId_idx" ON "bot_access"("userId");
GRANT SELECT, INSERT, UPDATE, DELETE ON "bot_access" TO rakazo_app;

ALTER TABLE "messages" ADD COLUMN "authorUserId" TEXT;
