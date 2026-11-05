-- Additive: older releases never read or write it. A server that ran this under its earlier name
-- already has the column.
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "objectStorageCipher" TEXT;
