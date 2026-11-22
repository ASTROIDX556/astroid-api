-- astroid:allow-destructive the operation-scoped unique index is replaced by the route-scoped index created in 20261122100100_add_idempotency_route_unique_index.
-- Existing rows keep working: every historical record was written by the
-- `transactions.create` operation, which is also the default for `route`.
ALTER TABLE "transaction_idempotency_records"
    ADD COLUMN "route" TEXT NOT NULL DEFAULT 'transactions.create',
    ADD COLUMN "responseStatus" INTEGER,
    ADD COLUMN "requestId" TEXT,
    ADD COLUMN "completedAt" TIMESTAMP(3);

ALTER TYPE "IdempotencyStatus" ADD VALUE IF NOT EXISTS 'FAILED';

DROP INDEX "transaction_idempotency_records_principalId_operation_keyHa_key";
