-- Migration: add_budget_reservation_period_start
-- Closes #570 — a budget reservation belongs to the period it was taken in.
--
-- Settling or releasing a hold only adjusts "budgets"."spent" while the budget
-- is still in the same period, so releasing a hold made before a rollover can
-- never reduce the new period's spend. Additive and nullable: holds created
-- before this column fall back to comparing their "createdAt" with the
-- budget's current "periodStart".

-- AlterTable
ALTER TABLE "budget_reservations" ADD COLUMN     "periodStart" TIMESTAMP(3);
