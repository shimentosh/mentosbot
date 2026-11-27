-- Bots an invitation hands out, applied when the invitee joins.
CREATE TABLE "invitation_bot_access" (
  "invitationId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invitation_bot_access_pkey" PRIMARY KEY ("invitationId", "botId"),
  CONSTRAINT "invitation_bot_access_invitationId_fkey" FOREIGN KEY ("invitationId")
    REFERENCES "invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invitation_bot_access_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "invitation_bot_access_botId_idx" ON "invitation_bot_access"("botId");
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation_bot_access" TO rakazo_app;
