-- Balance snapshots are populated by the scheduled wallet reconciliation.
-- Both columns stay nullable: a wallet that has never been reconciled has no
-- known balance yet, and a failed fetch must never write one.
ALTER TABLE "wallets"
    ADD COLUMN "balance" DECIMAL(20,7),
    ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
