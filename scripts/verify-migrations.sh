#!/usr/bin/env bash
#
# Verifies the Prisma database migrations for the Astroid API.
#
# What it does, in order:
#   1. Generates the Prisma client.
#   2. Applies every pending migration to the target database (idempotent).
#   3. Drift check: rebuilds the schema purely from the committed migrations
#      (in an ephemeral shadow database) and fails if it does not match
#      prisma/schema.prisma. This catches schema edits that were never
#      captured in a migration.
#
# Env:
#   DATABASE_URL          (required) Target PostgreSQL the migrations are
#                         applied to — e.g. a fresh ephemeral CI database.
#   SHADOW_DATABASE_URL   (optional but recommended) An empty scratch database
#                         used for the drift check. When unset the drift check
#                         is skipped and only apply + status are verified.
#
# Exit code 0 when migrations apply cleanly and stay in sync with the schema.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying migrations to ${DATABASE_URL}"
npx prisma migrate deploy

echo "==> Checking migration status"
npx prisma migrate status

if [[ -n "${SHADOW_DATABASE_URL:-}" ]]; then
  echo "==> Drift check: rebuilding schema from migrations only"
  echo "    shadow database: ${SHADOW_DATABASE_URL}"
  # `--script` prints the SQL that would reconcile the migrations-built schema
  # with schema.prisma: nothing when in sync, the full delta when out of sync.
  # Strip blank lines and SQL comment markers so an "empty migration" counts as
  # in sync.
  drift="$(npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma \
    --script \
    --shadow-database-url "${SHADOW_DATABASE_URL}" \
    | grep -Ev '^[[:space:]]*$|^--' || true)"

  if [[ -n "${drift//[[:space:]]/}" ]]; then
    echo "!! Schema drift detected — schema.prisma differs from the applied migrations." >&2
    echo "$drift" >&2
    exit 1
  fi

  echo "==> Migrations are in sync with the schema"
else
  echo "!! SHADOW_DATABASE_URL unset — skipping drift check" >&2
fi

echo "==> Migration verification passed"