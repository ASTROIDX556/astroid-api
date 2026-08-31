-- Add integrity hash columns to audit_logs
ALTER TABLE "audit_logs" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "previousHash" TEXT;