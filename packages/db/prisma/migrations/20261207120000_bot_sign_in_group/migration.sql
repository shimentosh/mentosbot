-- Additive: the previous release never reads this column.
ALTER TABLE "bots" ADD COLUMN "signInGroup" TEXT;
