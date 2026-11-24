-- CreateEnum
CREATE TYPE "WebhookCircuitStatus" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "failureCategory" TEXT,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextRetryAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "webhook_circuit_states" (
    "webhookId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "WebhookCircuitStatus" NOT NULL DEFAULT 'CLOSED',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "cooldownEndsAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureCode" TEXT,
    "lastFailureReason" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_circuit_states_pkey" PRIMARY KEY ("webhookId")
);

-- CreateIndex
CREATE INDEX "webhook_circuit_states_organizationId_idx" ON "webhook_circuit_states"("organizationId");

-- CreateIndex
CREATE INDEX "webhook_circuit_states_status_idx" ON "webhook_circuit_states"("status");

-- AddForeignKey
ALTER TABLE "webhook_circuit_states" ADD CONSTRAINT "webhook_circuit_states_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_circuit_states" ADD CONSTRAINT "webhook_circuit_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
