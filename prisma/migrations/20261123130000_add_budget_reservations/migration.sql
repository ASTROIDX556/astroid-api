-- Migration: add_budget_reservations
-- Closes #606 — replace read-then-write budget consumption with atomic reservations.

-- New enum for reservation lifecycle.
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'SETTLED', 'RELEASED');

-- Atomic budget hold table. Each row represents one pending, settled or
-- released hold against a budget's remaining balance. The INSERT is guarded by
-- an UPDATE that decrements `spent` only when `limitAmount - spent >= amount`,
-- so the balance can never go negative under concurrency.
CREATE TABLE "budget_reservations" (
    "id"             TEXT NOT NULL,
    "budgetId"       TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount"         DECIMAL(30, 7) NOT NULL,
    "settledAmount"  DECIMAL(30, 7),
    "status"         "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- FK to budget; cascade-delete so orphan reservations are impossible.
ALTER TABLE "budget_reservations"
    ADD CONSTRAINT "budget_reservations_budgetId_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK to organization; cascade-delete consistent with every other org-scoped table.
ALTER TABLE "budget_reservations"
    ADD CONSTRAINT "budget_reservations_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Traceability: link a transaction to the reservation that guarded it.
ALTER TABLE "transactions"
    ADD COLUMN "budgetReservationId" TEXT;

ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_budgetReservationId_fkey"
    FOREIGN KEY ("budgetReservationId") REFERENCES "budget_reservations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes for common query patterns.
CREATE INDEX "budget_reservations_budgetId_status_idx"
    ON "budget_reservations"("budgetId", "status");

CREATE INDEX "budget_reservations_organizationId_createdAt_idx"
    ON "budget_reservations"("organizationId", "createdAt");

-- Note: the index on transactions.budgetReservationId is in the next migration
-- (20261123140000) so it can use CONCURRENTLY, which Postgres forbids inside a
-- transaction block and therefore must be the sole statement in its migration.
