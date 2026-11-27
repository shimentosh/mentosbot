-- Who started the work a usage row paid for, when a teammate used someone else's shared bot.
ALTER TABLE "usage_records" ADD COLUMN "startedByUserId" TEXT;

UPDATE "usage_records" AS u
SET "startedByUserId" = m."authorUserId"
FROM "runs" AS r
JOIN "messages" AS m ON m."id" = r."sourceMessageId"
WHERE u."runId" = r."id"
  AND m."authorUserId" IS NOT NULL
  AND m."authorUserId" <> u."userId";
