-- Supports the action filter with deterministic keyset ordering.
-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
CREATE INDEX CONCURRENTLY "audit_logs_organizationId_action_createdAt_id_idx"
ON "audit_logs"("organizationId", "action", "createdAt", "id");
