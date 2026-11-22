-- astroid:allow-destructive rename preserves all existing hash-chain values
ALTER TABLE "audit_logs" RENAME COLUMN "previousHash" TO "prevHash";
