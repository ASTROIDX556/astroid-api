-- Scope idempotency keys explicitly by authenticated credential. The existing
-- rows keep working: their scope is backfilled from principalId, which is what
-- callers used as the sole namespace before this migration.

ALTER TABLE "idempotency_records" ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';

UPDATE "idempotency_records" SET "scope" = "principalId" WHERE "scope" = '';

-- astroid:allow-destructive the unique index is replaced by an equivalent one on the backfilled scope column; no rows are removed
DROP INDEX "idempotency_records_principalId_route_keyHash_key";
CREATE UNIQUE INDEX "idempotency_records_scope_route_keyHash_key" ON "idempotency_records"("scope", "route", "keyHash");
