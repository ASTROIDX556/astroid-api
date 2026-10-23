-- Rollback for 20261022090400_add_users_org_status_created_at_index.
-- IF EXISTS makes the rollback idempotent: running it again is a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "users_organizationId_status_createdAt_idx";
