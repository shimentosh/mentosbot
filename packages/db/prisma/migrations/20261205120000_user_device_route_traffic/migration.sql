-- Additive: the previous release never reads this column.
ALTER TABLE "user_devices" ADD COLUMN "routeTraffic" BOOLEAN NOT NULL DEFAULT false;
