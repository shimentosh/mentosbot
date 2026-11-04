-- The bell: pointers to what each person's bots finished, failed or asked for.
CREATE TABLE "inbox_notifications" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "groupId" TEXT,
  "runId" TEXT,
  "kind" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_notifications_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbox_notifications_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbox_notifications_botId_fkey" FOREIGN KEY ("botId")
    REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inbox_notifications_threadId_fkey" FOREIGN KEY ("threadId")
    REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "inbox_notifications_userId_createdAt_idx" ON "inbox_notifications"("userId", "createdAt");
CREATE INDEX "inbox_notifications_runId_idx" ON "inbox_notifications"("runId");

ALTER TABLE "inbox_notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbox_notifications_tenant ON "inbox_notifications"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY inbox_notifications_system ON "inbox_notifications"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "inbox_notifications" TO rakazo_app;
