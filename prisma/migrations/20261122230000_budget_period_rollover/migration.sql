-- Issue #512: fixed-period budget rollover with explicit carry-over rules.

-- NONE is the safest default: a budget keeps resetting its spend to zero until
-- an owner opts into carrying an amount across the period boundary.
CREATE TYPE "BudgetCarryOverRule" AS ENUM ('NONE', 'UNUSED', 'OVERSPEND', 'NET');
CREATE TYPE "BudgetPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

ALTER TABLE "budgets" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "budgets" ADD COLUMN "carryOverRule" "BudgetCarryOverRule" NOT NULL DEFAULT 'NONE';
ALTER TABLE "budgets" ADD COLUMN "periodEnd" TIMESTAMP(3);
ALTER TABLE "budgets" ADD COLUMN "periodAnchor" TIMESTAMP(3);
ALTER TABLE "budgets" ADD COLUMN "periodIndex" INTEGER NOT NULL DEFAULT 0;

-- Existing budgets retain their UTC semantics. ONE_TIME budgets never roll over
-- and therefore keep a null periodEnd, which the rollover query excludes.
UPDATE "budgets"
SET "periodEnd" = CASE "period"
    WHEN 'DAILY' THEN "periodStart" + INTERVAL '1 day'
    WHEN 'WEEKLY' THEN "periodStart" + INTERVAL '7 days'
    WHEN 'QUARTERLY' THEN "periodStart" + INTERVAL '3 months'
    WHEN 'YEARLY' THEN "periodStart" + INTERVAL '1 year'
    ELSE "periodStart" + INTERVAL '1 month'
END
WHERE "period" <> 'ONE_TIME' AND "periodEnd" IS NULL;

-- The anchor is the original first period, kept so Jan 31 -> Feb 28 -> Mar 31
-- never drifts into Mar 28 after several rollovers.
UPDATE "budgets" SET "periodAnchor" = "periodStart" WHERE "periodAnchor" IS NULL;

CREATE TABLE "budget_periods" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "BudgetPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "finalSpent" DECIMAL(30,7),
    "openingBalance" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "carryOverRule" "BudgetCarryOverRule" NOT NULL DEFAULT 'NONE',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_periods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "budget_periods_budgetId_periodStart_key" ON "budget_periods"("budgetId", "periodStart");
CREATE INDEX "budget_periods_organizationId_periodEnd_idx" ON "budget_periods"("organizationId", "periodEnd");
CREATE INDEX "budget_periods_status_periodEnd_idx" ON "budget_periods"("status", "periodEnd");

ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
