#!/usr/bin/env bash
set -euo pipefail

echo "Starting database migration verification..."

# 1. Validate Prisma schema syntax
echo "Validating Prisma schema..."
npx prisma validate

MIGRATIONS_DIR="prisma/migrations"

if [ -d "$MIGRATIONS_DIR" ]; then
  echo "Checking migration directories under $MIGRATIONS_DIR..."
  
  declare -A timestamps
  migration_count=0

  for dir in "$MIGRATIONS_DIR"/*/;
  do
    # Skip if not a directory or if it's not a migration folder
    [ -d "$dir" ] || continue
    dirname=$(basename "$dir")
    
    # Skip lock files or other non-migration directories if any
    if [ "$dirname" = "migration_lock.toml" ]; then
      continue
    fi

    migration_count=$((migration_count + 1))
    echo "Inspecting migration: $dirname"

    # Check 2: Verify migration.sql exists and is non-empty
    sql_file="${dir}migration.sql"
    if [ ! -f "$sql_file" ]; then
      echo "Error: Missing migration.sql in migration folder '$dirname'"
        exit 1
      fi

    if [ ! -s "$sql_file" ]; then
      echo "Error: migration.sql in '$dirname' is empty"
      exit 1
    fi

    # Check 3: Extract timestamp prefix (expects YYYYMMDDHHMMSS or similar leading numeric prefix)
    if [[ "$dirname" =~ ^([0-9]{14}) ]]; then
      ts="${BASH_REMATCH[1]}"
      if [ -n "${timestamps[$ts]:-}" ]; then
        echo "Error: Conflicting migration timestamps detected: '$dirname' shares timestamp prefix with '${timestamps[$ts]}'"
        exit 1
      fi
      timestamps["$ts"]="$dirname"
    else
      echo "Warning: Migration directory '$dirname' does not start with a standard 14-digit timestamp (YYYYMMDDHHMMSS)"
    fi
  done

  echo "Successfully verified $migration_count migration folder(s)."
else
  echo "No migrations directory found at $MIGRATIONS_DIR."
fi

# Check 4: Optionally check git working tree cleanliness if in CI or requested
if [ "${CI:-false}" = "true" ] || [ "${CHECK_GIT_DIRTY:-false}" = "true" ]; then
  echo "Checking git working tree state..."
  if [ -n "$(git status --porcelain)" ]; then
    echo "Error: Git working tree is dirty. Uncommitted migration or schema changes detected."
    git status --porcelain
    exit 1
  fi
fi

echo "Migration verification completed successfully!"
