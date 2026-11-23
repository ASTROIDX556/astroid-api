-- astroid:allow-destructive drops an index made redundant by a wider index with the same leading columns; no data is removed.
-- Superseded by "audit_logs_organizationId_action_createdAt_id_idx", which has
-- the same leading columns plus the keyset tiebreaker.
-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_organizationId_action_createdAt_idx";
