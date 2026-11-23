-- Issue #539: API key scopes.
-- Stored as a string array so a key carries its grants in one row. An empty
-- array is the legacy "unrestricted" key from before this migration.
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Issue #547: correlate audit entries with the originating request.
ALTER TABLE "audit_logs" ADD COLUMN "requestId" TEXT;

-- Issue #550: webhook delivery attempt tracking + dead-lettering.
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'FAILED_PERMANENTLY';

ALTER TABLE "webhook_deliveries" RENAME COLUMN "responseStatus" TO "lastStatusCode";
ALTER TABLE "webhook_deliveries" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "webhook_deliveries" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "webhook_deliveries" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx"
  ON "webhook_deliveries"("status", "nextAttemptAt");
