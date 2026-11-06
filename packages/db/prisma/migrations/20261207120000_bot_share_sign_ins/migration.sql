-- Additive: the previous release never reads this column.
ALTER TABLE "bots" ADD COLUMN "shareSignIns" BOOLEAN NOT NULL DEFAULT false;
