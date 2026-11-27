-- Additive: the previous release never writes this column, and every thread it creates still
-- has exactly one owner.
ALTER TABLE "threads" ADD COLUMN "memberBotId" TEXT;

-- NOT VALID lets both constraints commit without scanning threads under their locks; each is
-- validated in its own later migration, which lets reads and writes continue.
ALTER TABLE "threads" ADD CONSTRAINT "threads_memberBotId_fkey" FOREIGN KEY ("memberBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- A teammate's own chat with a bot shared with them is owned by that bot.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "helperBotId", "memberBotId") = 1
) NOT VALID;
