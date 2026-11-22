-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[];
