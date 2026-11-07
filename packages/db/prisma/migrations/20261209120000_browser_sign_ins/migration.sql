-- Additive: the previous release never reads this table.
CREATE TABLE "browser_sign_ins" (
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browser_sign_ins_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "browser_sign_ins" ADD CONSTRAINT "browser_sign_ins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
