-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "approvals_expiresAt_idx" ON "approvals"("expiresAt");
CREATE INDEX "proposals_status_expiresAt_idx" ON "proposals"("status", "expiresAt");

-- Backfill existing pending proposals without expiresAt to default 72h from creation
UPDATE "proposals" SET "expiresAt" = "createdAt" + INTERVAL '72 hours' WHERE "expiresAt" IS NULL AND "status" = 'PENDING';
