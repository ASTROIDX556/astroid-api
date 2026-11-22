-- One statement per migration: Postgres refuses CONCURRENTLY inside a
-- transaction block (see docs/concurrent-indexes.md).
CREATE UNIQUE INDEX CONCURRENTLY "transaction_idempotency_records_principalId_route_keyHash_key"
ON "transaction_idempotency_records"("principalId", "route", "keyHash");
