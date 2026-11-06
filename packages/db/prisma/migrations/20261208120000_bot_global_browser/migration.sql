-- Bots use the owner's global browser by default; Independent is the per-bot opt-out.
-- Safe with the previous release: it already reads and writes this column.
ALTER TABLE "bots" ALTER COLUMN "shareSignIns" SET DEFAULT true;
UPDATE "bots" SET "shareSignIns" = true WHERE "shareSignIns" = false;
