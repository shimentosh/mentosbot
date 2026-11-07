-- The person's own words behind a ticket a bot created, so the bot that works it knows the request is theirs.
ALTER TABLE "tickets" ADD COLUMN "ownerRequest" TEXT;
