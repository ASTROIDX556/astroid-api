-- Rollback for 20261022090300_add_wallets_org_status_created_at_index.
-- IF EXISTS makes the rollback idempotent: running it again is a no-op.
DROP INDEX CONCURRENTLY IF EXISTS "wallets_organizationId_status_createdAt_idx";
