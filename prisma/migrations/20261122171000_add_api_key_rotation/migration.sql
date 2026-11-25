-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN "lastFour" TEXT;
ALTER TABLE "api_keys" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "api_keys" ADD COLUMN "rotatedAt" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN "replacementId" TEXT;
