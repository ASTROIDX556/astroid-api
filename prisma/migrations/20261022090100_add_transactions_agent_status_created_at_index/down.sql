-- Rollback for 20261022090100_add_transactions_agent_status_created_at_index.
-- IF EXISTS makes the rollback idempotent: running it again is a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "transactions_agentId_status_createdAt_idx";
