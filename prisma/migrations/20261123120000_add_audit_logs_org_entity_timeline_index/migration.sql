-- Supports the resourceType filter (the `entity` column) with deterministic
-- keyset ordering. The resource timeline index leads with (organizationId,
-- entity, entityId), so a resource-type-only filter could not use it for the
-- createdAt/id ordering.
-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
CREATE INDEX CONCURRENTLY "audit_logs_organizationId_entity_createdAt_id_idx"
ON "audit_logs"("organizationId", "entity", "createdAt", "id");
