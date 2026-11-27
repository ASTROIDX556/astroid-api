-- Add grace period and rotation tracking fields to api_keys
ALTER TABLE "api_keys" ADD COLUMN "graceExpiresAt" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN "rotatedFromId" TEXT;

-- Index for efficient lookup of predecessors and successors
CREATE INDEX "api_keys_rotatedFromId_idx" ON "api_keys"("rotatedFromId");

-- Foreign key from rotated keys back to their predecessors
-- (applied at application logic level; schema allows NULL for non-rotated keys)
COMMENT ON COLUMN "api_keys"."graceExpiresAt" IS 'When the predecessor key\'s grace period expires; null if key has never been rotated';
COMMENT ON COLUMN "api_keys"."rotatedFromId" IS 'ID of the predecessor key that this key was rotated from; null if this is an original key';