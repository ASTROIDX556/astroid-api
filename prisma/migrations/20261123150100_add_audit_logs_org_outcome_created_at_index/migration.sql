-- Supports the audit listing `outcome` filter within a tenant, newest first.
-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
CREATE INDEX CONCURRENTLY "audit_logs_organizationId_outcome_createdAt_idx"
ON "audit_logs"("organizationId", "outcome", "createdAt");
