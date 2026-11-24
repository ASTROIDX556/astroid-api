-- CreateTable
CREATE TABLE "cleanup_job_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "jobName" TEXT NOT NULL,
    "recordsDeleted" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cleanup_job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cleanup_job_logs_jobName_createdAt_idx" ON "cleanup_job_logs"("jobName", "createdAt");