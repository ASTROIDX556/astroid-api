CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED');

CREATE TABLE "transaction_idempotency_records" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "transactionId" TEXT,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transaction_idempotency_records_principalId_operation_keyHa_key"
ON "transaction_idempotency_records"("principalId", "operation", "keyHash");

CREATE INDEX "transaction_idempotency_records_expiresAt_idx"
ON "transaction_idempotency_records"("expiresAt");