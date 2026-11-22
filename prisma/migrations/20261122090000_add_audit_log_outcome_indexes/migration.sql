ALTER TABLE "audit_logs" ADD COLUMN "outcome" TEXT;

CREATE INDEX "audit_logs_organizationId_action_createdAt_idx"
ON "audit_logs"("organizationId", "action", "createdAt");

CREATE INDEX "audit_logs_organizationId_entity_entityId_idx"
ON "audit_logs"("organizationId", "entity", "entityId");

CREATE INDEX "audit_logs_organizationId_outcome_createdAt_idx"
ON "audit_logs"("organizationId", "outcome", "createdAt");
