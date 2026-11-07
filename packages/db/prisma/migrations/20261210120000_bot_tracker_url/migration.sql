-- An https page each bot keeps its work log in.
ALTER TABLE "bots" ADD COLUMN "trackerUrl" TEXT;
