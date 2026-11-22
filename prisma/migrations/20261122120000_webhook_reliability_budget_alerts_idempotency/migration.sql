-- Issue #546: append-only history of webhook delivery attempts.
CREATE TABLE "webhook_delivery_attempts" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_delivery_attempts_webhookId_idx" ON "webhook_delivery_attempts"("webhookId");
CREATE INDEX "webhook_delivery_attempts_organizationId_idx" ON "webhook_delivery_attempts"("organizationId");
CREATE INDEX "webhook_delivery_attempts_eventId_idx" ON "webhook_delivery_attempts"("eventId");
CREATE INDEX "webhook_delivery_attempts_createdAt_idx" ON "webhook_delivery_attempts"("createdAt");

ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Issue #520: per-budget alert threshold overrides.
ALTER TABLE "budgets" ADD COLUMN "alertThresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- Issue #520: ledger of emitted budget-threshold alerts, unique per period.
CREATE TABLE "budget_alerts" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "threshold" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "usageAmount" DECIMAL(30,7) NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "budget_alerts_budgetId_periodStart_threshold_key" ON "budget_alerts"("budgetId", "periodStart", "threshold");
CREATE INDEX "budget_alerts_organizationId_createdAt_idx" ON "budget_alerts"("organizationId", "createdAt");

ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Issue #534: reusable durable Idempotency-Key records.
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_principalId_route_keyHash_key" ON "idempotency_records"("principalId", "route", "keyHash");
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");
