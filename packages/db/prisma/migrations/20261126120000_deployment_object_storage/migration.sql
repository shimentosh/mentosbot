-- Additive: older releases never read or write it.
ALTER TABLE "deployment_settings" ADD COLUMN "objectStorageCipher" TEXT;
