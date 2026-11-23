-- Derived result of the audited operation ('SUCCESS' | 'FAILURE'), or NULL
-- when the action has no definitive outcome.
ALTER TABLE "audit_logs" ADD COLUMN "outcome" TEXT;
