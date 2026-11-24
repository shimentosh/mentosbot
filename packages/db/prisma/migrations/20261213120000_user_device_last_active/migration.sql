-- When a paired computer's app last reported someone using it.
ALTER TABLE "user_devices" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
