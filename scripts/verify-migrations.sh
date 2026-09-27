#!/usr/bin/env bash
#
# Verifies the Prisma database migrations for the Astroid API.
#
# What it does, in order:
#   1. Validates Prisma schema syntax.
#   2. Checks migration directories and naming conventions.
#   3. Generates the Prisma client.
#   4. Applies every pending migration to the target database (if DATABASE_URL is present and reachable).
#   5. Drift check: rebuilds the schema purely from the committed migrations (if SHADOW_DATABASE_URL is set).
#
# Exit code 0 when migrations are well-formed and valid.
set -euo pipefail

echo "==> Validating Prisma schema syntax"
npx prisma validate

echo "==> Checking migration folders and structure"
MIGRATION_DIR="prisma/migrations"
if [ -d "$MIGRATION_DIR" ]; then
  MIGRATION_DIRS=$(find "$MIGRATION_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
  echo "Found $MIGRATION_DIRS migration directory(ies)"
  
  for dir in "$MIGRATION_DIR"/*/; do
    if [ -d "$dir" ]; then
      dirname=$(basename "$dir")
      if [ "$dirname" != "migration_lock.toml" ]; then
        if [ ! -f "${dir}migration.sql" ]; then
          echo "Error: Migration directory '$dirname' is missing migration.sql" >&2
          exit 1
        fi
      fi
    fi
  done
  echo "All migration directories contain a valid migration.sql file"
else
  echo "Warning: $MIGRATION_DIR directory not found"
fi

echo "==> Generating Prisma client"
npx prisma generate

if [ -n "${DATABASE_URL:-}" ]; then
  echo "==> Applying migrations to ${DATABASE_URL}"
  npx prisma migrate deploy

  echo "==> Checking migration status"
  npx prisma migrate status

  if [[ -n "${SHADOW_DATABASE_URL:-}" ]]; then
    echo "==> Drift check: rebuilding schema from migrations only"
    echo "    shadow database: ${SHADOW_DATABASE_URL}"
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
    echo "==> SHADOW_DATABASE_URL unset — skipping drift check"
  fi
else
  echo "==> DATABASE_URL unset — skipping live migration deployment and drift check (schema validation and file checks passed successfully)"
fi

echo "==> Migration verification passed"
