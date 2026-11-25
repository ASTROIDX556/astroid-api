-- Rollback for 20261022090200_add_agents_org_status_created_at_index.
-- IF EXISTS makes the rollback idempotent: running it again is a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "agents_organizationId_status_createdAt_idx";
