#!/usr/bin/env bash
#
# Verifies the integrity of the Prisma migration history.
#
# Checks run in four tiers; each tier runs only when its inputs are available,
# so the script is useful both locally (`npm run db:verify`) and in CI:
#
#   1. Static (always)
#        - prisma/schema.prisma is valid
#        - migration_lock.toml exists and matches the schema's datasource provider
#        - every migration directory is correctly named, uniquely timestamped and
#          contains a migration.sql with at least one statement
#        - SQL is lexically well-formed: no merge-conflict markers, balanced
#          parentheses, terminated strings/comments, final statement ends in ';'
#        - no forbidden statement is present (DROP DATABASE, DROP SCHEMA, role
#          and privilege management, ALTER SYSTEM, ...)
#        - destructive statements (DROP TABLE/COLUMN, TRUNCATE, DELETE FROM,
#          column type changes, renames, ...) are rejected, not warned about,
#          unless the migration opts in with `-- astroid:allow-destructive`
#        - statements that cannot succeed on a populated table are rejected
#          (ADD COLUMN ... NOT NULL without DEFAULT)
#        - CREATE INDEX CONCURRENTLY follows docs/concurrent-indexes.md
#          (one statement per migration, never IF NOT EXISTS)
#
#   2. History (when MIGRATION_BASE_REF is set and resolvable in git)
#        - migrations that already exist on the base ref are not modified or
#          deleted (deployed databases record a checksum per migration)
#        - new migrations sort after the newest migration on the base ref
#
#   3. Database (when SHADOW_DATABASE_URL is set; the database is RESET)
#        - the full history replays cleanly, in order, on an empty database,
#          which validates SQL syntax and cross-migration dependencies
#        - schema.prisma has no changes missing from the migration history
#
#   4. Working tree (when CHECK_GIT_DIRTY=true)
#        - no uncommitted schema or migration changes
#
# Environment:
#   MIGRATIONS_DIR          migrations directory      (default: prisma/migrations)
#   SCHEMA_PATH             Prisma schema file        (default: prisma/schema.prisma)
#   MIGRATION_BASE_REF      git ref to compare against, e.g. origin/main
#   SHADOW_DATABASE_URL     disposable database for replay and drift checks
#   ALLOW_DESTRUCTIVE_MIGRATIONS=true  accept destructive statements everywhere
#   CHECK_GIT_DIRTY=true    also fail if the git working tree is dirty
#   SKIP_SCHEMA_VALIDATION=true  skip `prisma validate` (used by the script's tests)
#
# Exits non-zero if any error is found. All errors are reported before exiting.

set -euo pipefail

# Prisma orders migration folders bytewise; compare and sort the same way.
export LC_ALL=C

MIGRATIONS_DIR="${MIGRATIONS_DIR:-prisma/migrations}"
SCHEMA_PATH="${SCHEMA_PATH:-prisma/schema.prisma}"
MIGRATION_BASE_REF="${MIGRATION_BASE_REF:-}"
SHADOW_DATABASE_URL="${SHADOW_DATABASE_URL:-}"
ALLOW_DESTRUCTIVE_MIGRATIONS="${ALLOW_DESTRUCTIVE_MIGRATIONS:-false}"

# Comment a migration has to carry to opt in to destructive statements.
DESTRUCTIVE_OPT_IN='astroid:allow-destructive'

errors=0
warnings=0

# --- reporting ---------------------------------------------------------------

# Emits a GitHub Actions annotation in CI, or a plain prefixed line locally.
#   annotate <level> <file> <line> <message>
annotate() {
  local level="$1" file="$2" line="$3" message="$4"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    local location=""
    [ -n "$file" ] && location=" file=${file}"
    [ -n "$file" ] && [ -n "$line" ] && location="${location},line=${line}"
    echo "::${level}${location}::${message}"
  else
    local where=""
    [ -n "$file" ] && where="${file}${line:+:$line}: "
    local label
    label="$(printf '%s' "$level" | tr '[:lower:]' '[:upper:]')"
    echo "${label}: ${where}${message}"
  fi
}

error() {
  errors=$((errors + 1))
  annotate error "${2:-}" "${3:-}" "$1" >&2
}

warn() {
  warnings=$((warnings + 1))
  annotate warning "${2:-}" "${3:-}" "$1" >&2
}

section() {
  echo
  echo "==> $1"
}

# --- helpers ------------------------------------------------------------------

# Removes the query string and trailing slashes so two URLs can be compared.
normalize_db_url() {
  printf '%s' "${1:-}" | sed -e 's/?.*$//' -e 's#/*$##'
}

# True when the migration carries the explicit destructive opt-in comment.
has_destructive_opt_in() {
  grep -qiE "^[[:space:]]*--[[:space:]]*${DESTRUCTIVE_OPT_IN}([^a-z0-9_]|\$)" "$1"
}

# True when the file contains an unresolved merge-conflict marker.
has_conflict_marker() {
  grep -qE '^[[:space:]]*(<<<<<<<|=======|>>>>>>>)( |$)' "$1"
}

# --- SQL lexer ------------------------------------------------------------------

# Scans a migration.sql file, skipping comments and string/identifier/dollar-
# quoted literals, and prints one tab-separated finding per line:
#   E <line> <message>     lexical error
#   F <line> <statement>   forbidden statement (never allowed)
#   D <line> <statement>   destructive statement (needs an explicit opt-in)
#   S <line> <message>     statement that cannot succeed / breaks repo rules
#   W <line> <statement>   advisory (reported for new migrations only)
#
# Statements are analysed as a whole, not line by line, so multi-line
# statements are classified correctly. Written for POSIX awk so it runs under
# mawk on ubuntu-latest.
lint_sql() {
  awk '
    function collapse(s,   t) {
      t = s
      gsub(/[ \t\r\n]+/, " ", t)
      sub(/^ /, "", t)
      sub(/ $/, "", t)
      return t
    }

    function shorten(s,   n) {
      n = 120
      if (length(s) > n) return substr(s, 1, n) "..."
      return s
    }

    # Returns the table of a CREATE TABLE / ALTER TABLE statement.
    function table_name(text, verb,   rest, name) {
      if (match(text, ("^" verb "[ \t]+TABLE[ \t]+")) == 0) return ""
      rest = substr(text, RLENGTH + 1)
      if (match(rest, /^IF[ \t]+NOT[ \t]+EXISTS[ \t]+/)) rest = substr(rest, RLENGTH + 1)
      if (match(rest, /^("[^"]+"|[A-Za-z0-9_]+)/) == 0) return ""
      name = substr(rest, RSTART, RLENGTH)
      gsub(/"/, "", name)
      return tolower(name)
    }

    # Returns the table an index is created on ("CREATE INDEX ... ON <table>").
    function index_table(text,   rest, name) {
      if (match(text, /[ \t]ON[ \t]+/) == 0) return ""
      rest = substr(text, RSTART + RLENGTH)
      if (match(rest, /^("[^"]+"|[A-Za-z0-9_]+)/) == 0) return ""
      name = substr(rest, RSTART, RLENGTH)
      gsub(/"/, "", name)
      return tolower(name)
    }

    # Classifies one complete statement. up is the upper-cased statement with
    # comments removed and string literals masked; raw is the original text and
    # is only used for the message shown to the reviewer.
    function analyse(up, raw,   disp, tbl, upraw, clauses, clause_count, clause, clause_index) {
      disp = shorten(collapse(raw))
      upraw = toupper(raw)

      # --- forbidden: never acceptable in an application migration ----------
      if (up ~ /DROP[ \t]+DATABASE/ ||
          up ~ /DROP[ \t]+SCHEMA/ ||
          up ~ /(^|[^A-Z0-9_])(CREATE|ALTER|DROP)[ \t]+(ROLE|USER|GROUP)/ ||
          up ~ /(^|[^A-Z0-9_])(GRANT|REVOKE)[ \t]+/ ||
          up ~ /ALTER[ \t]+SYSTEM/ ||
          up ~ /PG_TERMINATE_BACKEND/ ||
          up ~ /PG_CANCEL_BACKEND/ ||
          up ~ /REASSIGN[ \t]+OWNED/ ||
          up ~ /COPY[ \t].*PROGRAM/) {
        printf "F\t%d\t%s\n", stmt_line, disp
      }

      # --- destructive: rejected unless the migration opts in ---------------
      if (up ~ /DROP[ \t]+(TABLE|COLUMN|TYPE|VIEW|MATERIALIZED|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|EXTENSION|CONSTRAINT|DOMAIN|RULE|POLICY)/ ||
          up ~ /TRUNCATE[ \t]/ ||
          up ~ /DELETE[ \t]+FROM/ ||
          (up ~ /^UPDATE[ \t]+/ && up !~ /[ \t]WHERE[ \t]/) ||
          up ~ /ALTER[ \t]+COLUMN[^;]*[ \t]TYPE[ \t]/ ||
          up ~ /SET[ \t]+NOT[ \t]+NULL/ ||
          up ~ /RENAME[ \t]+(TO|COLUMN|CONSTRAINT)/) {
        printf "D\t%d\t%s\n", stmt_line, disp
      }

      # --- unsafe: cannot succeed on a table that already holds rows -------
      if (up ~ /ADD[ \t]+COLUMN/) {
        clause_count = split(up, clauses, ",")
        for (clause_index = 1; clause_index <= clause_count; clause_index++) {
          clause = clauses[clause_index]
          if (clause ~ /ADD[ \t]+COLUMN/ && clause ~ /NOT[ \t]+NULL/ && clause !~ /DEFAULT/) {
            tbl = table_name(upraw, "ALTER")
            if (tbl != "" && !(tbl in created)) {
              printf "S\t%d\t%s\n", stmt_line, "ADD COLUMN ... NOT NULL without DEFAULT on table \"" tbl "\" fails as soon as the table holds rows"
            }
            break
          }
        }
      }

      # --- advisory: index creation conventions -----------------------------
      if (up ~ /CREATE[ \t]+(UNIQUE[ \t]+)?INDEX[ \t]+/ && up !~ /INDEX[ \t]+CONCURRENTLY/) {
        tbl = index_table(up)
        if (tbl != "" && !(tbl in created)) {
          printf "W\t%d\t%s\n", stmt_line, disp
        }
      }
    }

    BEGIN {
      state = "code"; depth = 0; stmt = ""; raw = ""
      stmt_line = 0; has_code = 0; stmt_count = 0
      concurrent_line = 0; concurrent_count = 0; concurrent_if_not_exists = 0
      split("", created)
    }

    {
      sub(/\r$/, "")
      line = $0
      if (line ~ /^[ \t]*(<<<<<<<|=======|>>>>>>>)( |$)/) {
        printf "E\t%d\tunresolved merge-conflict marker\n", NR
        next
      }
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        c2 = substr(line, i, 2)
        if (state == "block") {
          if (c2 == "*/") { state = "code"; i += 2 } else { i++ }
          continue
        }
        if (state == "squote") {
          if (c == "\047") {
            if (substr(line, i + 1, 1) == "\047") { raw = raw "\047\047"; i += 2; continue }
            raw = raw "\047"
            state = "code"
          } else {
            raw = raw c
          }
          i++
          continue
        }
        if (state == "dquote") {
          if (c == "\"") { raw = raw "\""; state = "code" } else { raw = raw c }
          i++
          continue
        }
        if (state == "dollar") {
          if (substr(line, i, length(tag)) == tag) { raw = raw tag; state = "code"; i += length(tag) } else { raw = raw c; i++ }
          continue
        }

        # state == "code"
        if (c2 == "--") { break }
        if (c2 == "/*") { state = "block"; opened = NR; stmt = stmt " "; raw = raw " "; i += 2; continue }
        if (c == "\047") {
          state = "squote"; opened = NR
          if (!has_code) { stmt_line = NR; has_code = 1 }
          stmt = stmt "\047\047"; raw = raw "\047"; i++; continue
        }
        if (c == "\"") {
          state = "dquote"; opened = NR
          if (!has_code) { stmt_line = NR; has_code = 1 }
          stmt = stmt "\"\""; raw = raw "\""; i++; continue
        }
        if (c == "$" && match(substr(line, i), /^\$[A-Za-z_]*\$/)) {
          tag = substr(line, i, RLENGTH); state = "dollar"; opened = NR
          if (!has_code) { stmt_line = NR; has_code = 1 }
          i += RLENGTH
          continue
        }
        if (c == "(") {
          if (depth == 0) { paren = NR }
          depth++
        } else if (c == ")") {
          if (depth == 0) {
            printf "E\t%d\tunbalanced \")\" with no matching \"(\"\n", NR
          } else {
            depth--
          }
        } else if (c == ";") {
          if (depth > 0) {
            printf "E\t%d\tstatement ends with %d unclosed \"(\" (opened on line %d)\n", NR, depth, paren
            depth = 0
          }
          if (has_code) {
            up = toupper(stmt)
            if (up ~ /CREATE[ \t]+(UNIQUE[ \t]+)?INDEX[ \t]+CONCURRENTLY/) {
              concurrent_count++
              if (concurrent_line == 0) concurrent_line = stmt_line
              if (up ~ /CONCURRENTLY[ \t]+IF[ \t]+NOT[ \t]+EXISTS/) concurrent_if_not_exists = 1
            }
            if (up ~ /^CREATE[ \t]+TABLE[ \t]+/) {
              created[table_name(toupper(raw), "CREATE")] = 1
            }
            analyse(up, raw)
            stmt_count++
          }
          stmt = ""; raw = ""; has_code = 0
          i++
          continue
        }
        if (c != " " && c != "\t") {
          if (!has_code) { stmt_line = NR; has_code = 1 }
        }
        stmt = stmt c
        raw = raw c
        i++
      }
      if (has_code) { stmt = stmt " "; raw = raw " " }
    }

    END {
      if (state == "block") {
        printf "E\t%d\tunterminated /* comment (opened on line %d)\n", NR, opened
      } else if (state == "squote") {
        printf "E\t%d\tunterminated string literal (opened on line %d)\n", NR, opened
      } else if (state == "dquote") {
        printf "E\t%d\tunterminated quoted identifier (opened on line %d)\n", NR, opened
      } else if (state == "dollar") {
        printf "E\t%d\tunterminated dollar-quoted string %s (opened on line %d)\n", NR, tag, opened
      }
      if (depth > 0) {
        printf "E\t%d\t%d unclosed \"(\" (opened on line %d)\n", NR, depth, paren
      }
      if (stmt_count == 0 && !has_code) {
        printf "E\t1\tcontains no SQL statements (only comments or whitespace)\n"
      } else if (has_code && state == "code") {
        printf "E\t%d\tfinal statement is not terminated with \";\"\n", stmt_line
      }
      if (concurrent_if_not_exists) {
        printf "S\t%d\tCREATE INDEX CONCURRENTLY ... IF NOT EXISTS is not allowed; a failed concurrent build leaves an invalid index behind (see docs/concurrent-indexes.md)\n", concurrent_line
      }
      if (concurrent_count > 0 && stmt_count > 1) {
        printf "S\t%d\tCREATE INDEX CONCURRENTLY must be the only statement in a migration; PostgreSQL refuses it inside a transaction block and Prisma sends a multi-statement migration as one (see docs/concurrent-indexes.md)\n", concurrent_line
      }
    }
  ' "$1"
}

# --- base ref resolution --------------------------------------------------------

# Resolved before the static tier so the advisory checks can tell new
# migrations from migrations that are already on the base ref.
base_commit=""
base_migrations=()
base_ref_state="unset"

if [ -n "$MIGRATION_BASE_REF" ]; then
  if [ ! -d "$MIGRATIONS_DIR" ]; then
    base_ref_state="no-migrations"
  elif ! base_commit="$(git -C "$MIGRATIONS_DIR" merge-base "$MIGRATION_BASE_REF" HEAD 2>/dev/null)"; then
    base_ref_state="unresolvable"
  else
    base_ref_state="resolved"
    while IFS= read -r name; do
      [ -n "$name" ] && base_migrations+=("$name")
    done < <(git -C "$MIGRATIONS_DIR" ls-tree -d --name-only "$base_commit" ./ | sed 's#.*/##' | sort)
  fi
fi

# True when the migration already exists on the base ref.
is_base_migration() {
  local name="$1" base_name
  for base_name in "${base_migrations[@]}"; do
    [ "$base_name" = "$name" ] && return 0
  done
  return 1
}

# --- 1. static checks ------------------------------------------------------------

echo "Verifying Prisma migrations in ${MIGRATIONS_DIR}"

section "Schema"
if [ ! -f "$SCHEMA_PATH" ]; then
  error "Prisma schema not found" "$SCHEMA_PATH"
elif [ "${SKIP_SCHEMA_VALIDATION:-false}" = "true" ]; then
  echo "Skipping prisma validate (SKIP_SCHEMA_VALIDATION=true)."
else
  # `prisma validate` resolves env() in the datasource; a placeholder keeps the
  # check usable without a configured database. It never connects.
  if ! DATABASE_URL="${DATABASE_URL:-postgresql://placeholder:placeholder@localhost:5432/placeholder}" \
    npx --no-install prisma validate --schema "$SCHEMA_PATH"; then
    error "Prisma schema is invalid; see the prisma validate output above" "$SCHEMA_PATH"
  fi
fi

schema_provider=""
if [ -f "$SCHEMA_PATH" ]; then
  schema_provider="$(awk '
    /^[ \t]*datasource[ \t]/ { in_ds = 1 }
    in_ds && /^[ \t]*provider[ \t]*=/ {
      match($0, /"[^"]*"/); print substr($0, RSTART + 1, RLENGTH - 2); exit
    }
    in_ds && /^[ \t]*}/ { in_ds = 0 }
  ' "$SCHEMA_PATH")"
fi

section "Migration structure"

migrations=()
if [ ! -d "$MIGRATIONS_DIR" ]; then
  if [ -f "$SCHEMA_PATH" ] && grep -qE '^[[:space:]]*model[[:space:]]' "$SCHEMA_PATH"; then
    error "Migrations directory not found, but the schema defines models. Create one with: npx prisma migrate dev --name init" "$MIGRATIONS_DIR"
  else
    echo "No migrations directory found at ${MIGRATIONS_DIR}."
  fi
else
  lock_file="${MIGRATIONS_DIR}/migration_lock.toml"
  if [ ! -f "$lock_file" ]; then
    error "migration_lock.toml is missing; it is generated by prisma migrate dev and must be committed" "$lock_file"
  else
    lock_provider="$(sed -n 's/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$lock_file" | head -n 1)"
    if [ -z "$lock_provider" ]; then
      error "migration_lock.toml does not declare a provider" "$lock_file"
    else
      if [ -n "$schema_provider" ] && [ "$lock_provider" != "$schema_provider" ]; then
        error "migration_lock.toml provider \"${lock_provider}\" does not match the schema datasource provider \"${schema_provider}\"" "$lock_file"
      fi
    fi
  fi

  seen_timestamps=()
  for entry in "$MIGRATIONS_DIR"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"

    if [ ! -d "$entry" ]; then
      [ "$name" = "migration_lock.toml" ] && continue
      error "Unexpected file in migrations directory; migrations must live in their own folder as <folder>/migration.sql" "$entry"
      continue
    fi

    migrations+=("$name")

    # Prisma applies migrations in lexicographic folder order, so names must be
    # <14-digit timestamp>_<snake_case_name>. A "0_" prefix is Prisma's
    # documented convention for a baseline migration and sorts first.
    if [[ "$name" =~ ^([0-9]{14})_[a-z0-9_]+$ ]]; then
      ts="${BASH_REMATCH[1]}"
      previous_name=""
      for ((timestamp_index = 0; timestamp_index < ${#seen_timestamps[@]}; timestamp_index += 2)); do
        if [ "${seen_timestamps[$timestamp_index]}" = "$ts" ]; then
          previous_name="${seen_timestamps[$((timestamp_index + 1))]}"
          break
        fi
      done
      if [ -n "$previous_name" ]; then
        error "Timestamp ${ts} is shared with '${previous_name}'; regenerate one of them with prisma migrate dev so their order is deterministic" "$entry"
      else
        seen_timestamps+=("$ts" "$name")
      fi
    elif [[ ! "$name" =~ ^0_[a-z0-9_]+$ ]]; then
      error "Invalid migration folder name '${name}'; expected <YYYYMMDDHHMMSS>_<snake_case_name> as generated by prisma migrate dev" "$entry"
    fi

    sql_file="${entry}/migration.sql"
    if [ ! -f "$sql_file" ]; then
      error "Missing migration.sql; every migration folder must contain one (was the migration generated with --create-only and never saved?)" "$entry"
      continue
    fi

    # Leftovers from an interrupted merge are never valid: they hide the real
    # content of the migration and can be applied instead of it.
    for extra in "$entry"/* "$entry"/.[!.]*; do
      [ -e "$extra" ] || continue
      extra_name="$(basename "$extra")"
      case "$extra_name" in
        migration.sql|down.sql) continue ;;
        *.orig|*.rej|*.bak|*~)
          error "Leftover merge artefact '${extra_name}' in migration folder; resolve the conflict and delete the file" "$extra"
          continue
          ;;
      esac
      if [ -f "$extra" ] && has_conflict_marker "$extra"; then
        error "Unresolved merge-conflict marker in '${extra_name}'; resolve the conflict before merging" "$extra"
        continue
      fi
      warn "Unexpected file '${extra_name}' in migration folder; Prisma only applies migration.sql" "$entry"
    done

    # The destructive opt-in is per file and applies to the whole file.
    destructive_allowed=false
    if [ "$ALLOW_DESTRUCTIVE_MIGRATIONS" = "true" ]; then
      destructive_allowed=true
    elif has_destructive_opt_in "$sql_file"; then
      destructive_allowed=true
    fi

    # The advisory checks only apply to migrations that are not on the base ref:
    # the ones already merged cannot be changed any more. Without a base ref
    # there is no way to tell them apart, so the advisories are skipped.
    report_advisories=false
    if [ "$base_ref_state" = "resolved" ] && ! is_base_migration "$name"; then
      report_advisories=true
    fi

    while IFS=$'\t' read -r kind line message; do
      case "$kind" in
        E)
          error "Invalid SQL: ${message}" "$sql_file" "$line"
          ;;
        F)
          error "Forbidden statement: ${message}. Statements such as DROP DATABASE, DROP SCHEMA, role or privilege management (CREATE/ALTER/DROP ROLE|USER, GRANT, REVOKE) and ALTER SYSTEM must never appear in an application migration" "$sql_file" "$line"
          ;;
        D)
          if [ "$destructive_allowed" = true ]; then
            warn "Destructive statement: ${message}" "$sql_file" "$line"
          else
            error "Destructive statement is not allowed: ${message}. Add the comment '-- ${DESTRUCTIVE_OPT_IN} <reason>' to ${sql_file} if the change is intentional and data-safe, or export ALLOW_DESTRUCTIVE_MIGRATIONS=true to accept it locally" "$sql_file" "$line"
          fi
          ;;
        S)
          error "Unsafe statement: ${message}" "$sql_file" "$line"
          ;;
        W)
          if [ "$report_advisories" = true ]; then
            warn "Index created without CONCURRENTLY: ${message}. On a live table this blocks writes; build it with CREATE INDEX CONCURRENTLY in its own migration (see docs/concurrent-indexes.md)" "$sql_file" "$line"
          fi
          ;;
      esac
    done < <(lint_sql "$sql_file")

    # A hand-written rollback script is optional (docs/database.md); it is
    # checked for syntax only, because dropping things is its purpose.
    down_file="${entry}/down.sql"
    if [ -f "$down_file" ]; then
      while IFS=$'\t' read -r kind line message; do
        [ "$kind" = "E" ] && error "Invalid SQL in down.sql: ${message}" "$down_file" "$line"
      done < <(lint_sql "$down_file")
    fi
  done

  echo "Inspected ${#migrations[@]} migration folder(s)."

  if [ "${#migrations[@]}" -eq 0 ]; then
    if [ -f "$SCHEMA_PATH" ] && grep -qE '^[[:space:]]*model[[:space:]]' "$SCHEMA_PATH"; then
      error "The migration history is empty but the schema defines models. Create the baseline with: npx prisma migrate dev --name init" "$MIGRATIONS_DIR"
    else
      echo "The migration history is empty; the schema declares no models."
    fi
  fi
fi

# --- 2. history checks ---------------------------------------------------------

section "Migration history"

if [ -z "$MIGRATION_BASE_REF" ]; then
  echo "Skipping: set MIGRATION_BASE_REF (e.g. origin/main) to check that merged migrations are unchanged."
  echo "Skipping: the index advisories are only reported for migrations that are new relative to MIGRATION_BASE_REF."
elif [ "$base_ref_state" = "no-migrations" ]; then
  echo "Skipping: no migrations directory."
elif [ "$base_ref_state" = "unresolvable" ]; then
  warn "Skipping history checks: cannot resolve a merge base with '${MIGRATION_BASE_REF}' (is the ref fetched? CI needs fetch-depth: 0)"
else
  echo "Comparing against ${MIGRATION_BASE_REF} (merge base ${base_commit:0:12})."

  # Folder names are passed relative to MIGRATIONS_DIR, so git resolves them
  # regardless of where the repository root is.
  newest_base=""
  for name in "${base_migrations[@]}"; do
    newest_base="$name"
    if [ ! -d "${MIGRATIONS_DIR}/${name}" ]; then
      error "Migration '${name}' exists on ${MIGRATION_BASE_REF} but was deleted; applied migrations must never be removed" "${MIGRATIONS_DIR}/${name}"
    elif ! git -C "$MIGRATIONS_DIR" diff --quiet "$base_commit" -- "${name}/migration.sql"; then
      error "Migration '${name}' already exists on ${MIGRATION_BASE_REF} and was modified. Databases that applied it will report a checksum mismatch; revert the edit and add a new migration instead" "${MIGRATIONS_DIR}/${name}/migration.sql"
    fi
  done

  new_count=0
  for name in "${migrations[@]}"; do
    is_base_migration "$name" && continue
    new_count=$((new_count + 1))
    echo "New migration: ${name}"

    if [ -n "$newest_base" ] && [[ ! "$name" > "$newest_base" ]]; then
      error "New migration '${name}' sorts before '${newest_base}', the newest migration on ${MIGRATION_BASE_REF}; Prisma would apply it out of order. Regenerate it with a current timestamp" "${MIGRATIONS_DIR}/${name}"
    fi

    sql_file="${MIGRATIONS_DIR}/${name}/migration.sql"
    [ -f "$sql_file" ] || continue
    destructive_count="$(lint_sql "$sql_file" | awk -F'\t' '$1 == "D" { count++ } END { print count + 0 }')"
    if [ "$destructive_count" -gt 0 ]; then
      echo "  ${destructive_count} destructive statement(s); make sure the pull request explains how the existing data is handled."
    fi
  done
  echo "${new_count} new migration(s) relative to ${MIGRATION_BASE_REF}."
fi

# --- 3. database checks --------------------------------------------------------

section "Database replay and drift"

if [ -z "$SHADOW_DATABASE_URL" ]; then
  echo "Skipping: set SHADOW_DATABASE_URL to a disposable database to replay migrations and detect schema drift."
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
else
  if [ -n "${DATABASE_URL:-}" ] && [ "$(normalize_db_url "$SHADOW_DATABASE_URL")" = "$(normalize_db_url "$DATABASE_URL")" ]; then
    error "SHADOW_DATABASE_URL and DATABASE_URL point at the same database; the shadow database is reset by the verification, so it must be a disposable database of its own" "$SHADOW_DATABASE_URL"
  else
    # Fail early with a clear message when the shadow database is unreachable.
    if ! printf 'SELECT 1;\n' | DATABASE_URL="$SHADOW_DATABASE_URL" npx --no-install prisma db execute --stdin >/dev/null 2>&1; then
      error "Cannot connect to the shadow database. Create it first (the verification resets it) and check the credentials in SHADOW_DATABASE_URL" "$SHADOW_DATABASE_URL"
    else
      # Replays every migration, in order, on the (reset) shadow database, then
      # diffs the result against schema.prisma. Exit codes: 0 = no drift,
      # 2 = drift, anything else = a migration failed to apply.
      set +e
      diff_output="$(DATABASE_URL="${DATABASE_URL:-$SHADOW_DATABASE_URL}" npx --no-install prisma migrate diff \
        --from-migrations "$MIGRATIONS_DIR" \
        --to-schema-datamodel "$SCHEMA_PATH" \
        --shadow-database-url "$SHADOW_DATABASE_URL" \
        --script \
        --exit-code 2>&1)"
      status=$?
      set -e

      case "$status" in
        0)
          echo "All migrations replayed cleanly and match ${SCHEMA_PATH}."
          ;;
        2)
          echo "$diff_output"
          error "${SCHEMA_PATH} has changes that are not captured by any migration (SQL needed shown above). Generate one with: npx prisma migrate dev --name <change>" "$SCHEMA_PATH"
          ;;
        *)
          echo "$diff_output"
          error "Replaying the migration history on an empty database failed (see output above). A migration has invalid SQL or depends on an object created by a later migration" "$MIGRATIONS_DIR"
          ;;
      esac
    fi
  fi
fi

# --- 4. working tree ------------------------------------------------------------

if [ "${CHECK_GIT_DIRTY:-false}" = "true" ]; then
  section "Working tree"
  if [ -n "$(git status --porcelain)" ]; then
    git status --porcelain
    error "Git working tree is dirty; uncommitted migration or schema changes detected"
  else
    echo "Working tree is clean."
  fi
fi

# --- summary -------------------------------------------------------------------

echo
if [ "$errors" -gt 0 ]; then
  echo "Migration verification FAILED: ${errors} error(s), ${warnings} warning(s)."
  exit 1
fi
echo "Migration verification passed with ${warnings} warning(s)."
