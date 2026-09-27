#!/usr/bin/env bash
set -euo pipefail

echo "Starting database migration verification..."

# Validate Prisma schema syntax
echo "Validating Prisma schema..."
npx prisma validate

# Check if migration directory exists
MIGRATION_DIR="prisma/migrations"
if [ ! -d "$MIGRATION_DIR" ]; then
  echo "Error: Migration directory $MIGRATION_DIR does not exist."
  exit 1
fi

# Count migration folders
MIGRATION_DIRS=$(find "$MIGRATION_DIR" -mindepth 1 -maxdepth 1 -type d ! -name ".*")
DIR_COUNT=$(echo "$MIGRATION_DIRS" | grep -v '^$' | wc -l || true)
echo "Found $DIR_COUNT migration directory(ies)"

# Verify each migration directory
for dir in $MIGRATION_DIRS;
  if [ -d "$dir" ]; then
    BASENAME=$(basename "$dir")
    echo "Checking migration: $BASENAME"
    
    # Check for migration.sql
    if [ ! -f "${dir}/migration.sql" ]; then
      echo "Error: Migration $BASENAME is missing migration.sql"
      exit 1
    fi
    
    # Check naming convention (e.g., timestamp_name)
    if ! echo "$BASENAME" | grep -qE '^[0-9]{14}_[a-zA-Z0-9_-]+$'; then
      echo "Warning: Migration $BASENAME does not strictly match the YYYYMMDDHHMMSS_name format"
    fi
  fi
done

echo "Migration verification completed successfully!"
