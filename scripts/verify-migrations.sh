#!/usr/bin/env bash
set -e

echo "Starting database migration verification..."
echo "Validating Prisma schema..."
npx prisma validate

MIGRATIONS_DIR="prisma/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
  COUNT=$(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name 'migration_lock.toml' | wc -l)
  echo "Found $COUNT migration directory(ies)"
  for dir in "$MIGRATIONS_DIR"/*/; do
    if [ -d "$dir" ]; then
      if [ ! -f "${dir}migration.sql" ]; then
        echo "Error: Missing migration.sql in $dir"
        exit 1
      fi
    fi
  done
else
  echo "No migrations directory found."
fi

echo "Migration verification completed successfully!"
