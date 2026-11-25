-- Supports the actorId filter with deterministic keyset ordering.
-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
CREATE INDEX CONCURRENTLY "audit_logs_organizationId_userId_createdAt_id_idx"
ON "audit_logs"("organizationId", "userId", "createdAt", "id");
