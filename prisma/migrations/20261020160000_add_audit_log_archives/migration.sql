-- CreateTable
CREATE TABLE "audit_log_archives" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "payload" BYTEA NOT NULL,
    "checksum" TEXT NOT NULL,
    "chainBoundaryHash" TEXT,
    "archivedThrough" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_archives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_archives_batchId_key" ON "audit_log_archives"("batchId");

-- CreateIndex
CREATE INDEX "audit_log_archives_organizationId_archivedThrough_idx" ON "audit_log_archives"("organizationId", "archivedThrough");

-- CreateIndex
CREATE INDEX "audit_log_archives_createdAt_idx" ON "audit_log_archives"("createdAt");
