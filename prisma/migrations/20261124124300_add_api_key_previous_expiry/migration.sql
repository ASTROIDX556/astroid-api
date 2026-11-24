ALTER TABLE "api_keys" ADD COLUMN "previousKeyExpiresAt" TIMESTAMP(3);

UPDATE "api_keys"
SET "previousKeyExpiresAt" = "expiresAt"
WHERE "status" = 'rotating'
  AND "expiresAt" IS NOT NULL;
