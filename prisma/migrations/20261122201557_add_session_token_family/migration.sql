-- astroid:allow-destructive
--
-- Refresh-token reuse detection: add token-family fields to sessions.
--  - familyId: identifier shared by the sessions of one login lineage; new
--    sessions minted during a rotation inherit the family of the session they
--    replace, so presenting any of the family's tokens can revoke them all.
--  - consumedAt: set atomically when the refresh token is rotated.
--  - replacedByTokenId: on the replaced session, the id of its replacement.
-- The `SET NOT NULL` is safe: the preceding UPDATE backfills "familyId" with
-- each legacy session's own "id", so every row has a value before the
-- constraint is applied.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "familyId" TEXT;
ALTER TABLE "sessions" ADD COLUMN "consumedAt" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "replacedByTokenId" TEXT;

-- Backfill: legacy sessions are each their own family (safe default).
UPDATE "sessions" SET "familyId" = "id" WHERE "familyId" IS NULL;

-- AlterTable: make familyId required now that every row is backfilled.
ALTER TABLE "sessions" ALTER COLUMN "familyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");
