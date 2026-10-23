#!/usr/bin/env bash
#
# Verifies the integrity of the Prisma migration history.
#
# Checks run in five tiers; each tier runs only when its inputs are available,
# Checks run in four tiers; each tier runs only when its inputs are available,
# so the script is useful both locally (`npm run db:verify`) and in CI:
#
#   0. Prerequisites (always)
#        - the tools the script relies on are installed
#        - the Prisma CLI is available when it is needed
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
#          unless the migration opts in with `-- astroid:allow-destructive`.
#          A migration that is already merged cannot be changed any more, so it
#          is only reported as a warning.
#        - statements that cannot succeed on a populated table are rejected
#          (ADD COLUMN ... NOT NULL without DEFAULT)
#        - CREATE INDEX CONCURRENTLY follows docs/concurrent-indexes.md
#          (one statement per migration, never IF NOT EXISTS)
#
#   2. Schema coverage (always, no database required)
#        - every model, enum and column of schema.prisma is created by the
#          migration history, which detects a schema change that was committed
#          without its migration (schema drift) even without a shadow database
#
#   3. History (when MIGRATION_BASE_REF is set and resolvable in git)
#        - migrations that already exist on the base ref are not modified or
#          deleted (deployed databases record a checksum per migration)
#        - new migrations sort after the newest migration on the base ref
#
#   4. Database (when SHADOW_DATABASE_URL is set; the database is RESET)
#        - the full history replays cleanly, in order, on an empty database,
#          which validates SQL syntax and cross-migration dependencies
#        - `prisma migrate deploy` applies the history and leaves no pending
#          migration, which validates the path operators actually run
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
checks=0

work_dir=""
cleanup() {
  if [ -n "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
  return 0
}
trap cleanup EXIT

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

    # Key used to compare table names. Prisma always quotes identifiers, so
    # the comparison is case-insensitive.
    function table_key(name) {
      return tolower(name)
    }

    # Returns the table of a CREATE TABLE / ALTER TABLE statement, as written.
    # uptext is text upper-cased: it has the same length as text, so a match
    # position found in uptext points at the same character in text.
    function table_name(text, uptext, verb,   rest, uprest, name) {
      if (match(uptext, ("^" verb "[ \t]+TABLE[ \t]+")) == 0) return ""
      rest = substr(text, RLENGTH + 1)
      uprest = toupper(rest)
      if (match(uprest, /^IF[ \t]+NOT[ \t]+EXISTS[ \t]+/)) {
        rest = substr(text, RLENGTH + 1)
        uprest = toupper(rest)
      }
      if (match(uprest, /^("[^"]+"|[A-Za-z0-9_]+)/) == 0) return ""
      name = substr(rest, RSTART, RLENGTH)
      gsub(/"/, "", name)
      return name
    }

    # Returns the table an index is created on ("CREATE INDEX ... ON <table>").
    function index_table(text, uptext,   rest, uprest, name) {
      if (match(uptext, /[ \t]ON[ \t]+/) == 0) return ""
      rest = substr(text, RSTART + RLENGTH)
      uprest = toupper(rest)
      if (match(uprest, /^("[^"]+"|[A-Za-z0-9_]+)/) == 0) return ""
      name = substr(rest, RSTART, RLENGTH)
      gsub(/"/, "", name)
      return name
    }

    # Classifies one complete statement. up is the upper-cased statement with
    # comments removed and string literals masked; raw is the original text and
    # is only used for the message shown to the reviewer and for the names of
    # the objects the statement touches.
    function analyse(up, raw,   disp, tbl, upraw, flagged, clauses, clause_count, clause, clause_index) {
      disp = shorten(raw)
      upraw = toupper(raw)

      # --- forbidden: never acceptable in an application migration ----------
      if (up ~ /DROP[ \t]+DATABASE([^A-Z0-9_]|$)/ ||
          up ~ /DROP[ \t]+SCHEMA([^A-Z0-9_]|$)/ ||
          up ~ /(^|[^A-Z0-9_])(CREATE|ALTER|DROP)[ \t]+(ROLE|USER|GROUP)([^A-Z0-9_]|$)/ ||
          up ~ /(^|[^A-Z0-9_])(GRANT|REVOKE)[ \t]+/ ||
          up ~ /ALTER[ \t]+SYSTEM([^A-Z0-9_]|$)/ ||
          up ~ /PG_TERMINATE_BACKEND/ ||
          up ~ /PG_CANCEL_BACKEND/ ||
          up ~ /REASSIGN[ \t]+OWNED/ ||
          up ~ /COPY[ \t].*PROGRAM/) {
        printf "F\t%d\t%s\n", stmt_line, disp
      }

      # --- destructive: rejected unless the migration opts in ---------------
      if (up ~ /DROP[ \t]+(TABLE|COLUMN|TYPE|VIEW|MATERIALIZED|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|EXTENSION|CONSTRAINT|DOMAIN|RULE|POLICY)([^A-Z0-9_]|$)/ ||
          up ~ /TRUNCATE[ \t]/ ||
          up ~ /DELETE[ \t]+FROM/ ||
          (up ~ /^UPDATE[ \t]+/ && up !~ /[ \t]WHERE[ \t]/) ||
          up ~ /ALTER[ \t]+COLUMN[^;]*[ \t]TYPE[ \t]/ ||
          up ~ /SET[ \t]+NOT[ \t]+NULL/ ||
          up ~ /RENAME[ \t]+(TO|COLUMN|CONSTRAINT)/) {
        printf "D\t%d\t%s\n", stmt_line, disp
      }

      # --- unsafe: cannot succeed on a table that already holds rows -------
      if (up ~ /ADD[ \t]+COLUMN/ && up ~ /NOT[ \t]+NULL/) {
        flagged = 0
        if (up !~ /DEFAULT/) {
          # No DEFAULT anywhere: the statement cannot succeed on a populated
          # table, whatever the column type is.
          flagged = 1
        } else {
          # A DEFAULT may belong to another column of the same statement, so
          # every ADD COLUMN clause is checked on its own.
          clause_count = split(up, clauses, ",")
          for (clause_index = 1; clause_index <= clause_count; clause_index++) {
            clause = clauses[clause_index]
            if (clause ~ /ADD[ \t]+COLUMN/ && clause ~ /NOT[ \t]+NULL/ && clause !~ /DEFAULT/) {
              flagged = 1
              break
            }
          }
        }
        if (flagged) {
          tbl = table_name(raw, upraw, "ALTER")
          if (tbl != "" && !(table_key(tbl) in created)) {
            printf "S\t%d\t%s\n", stmt_line, "ADD COLUMN ... NOT NULL without DEFAULT on table \"" tbl "\" fails as soon as the table holds rows"
          }
        }
      }

      # --- advisory: index creation conventions -----------------------------
      if (up ~ /CREATE[ \t]+(UNIQUE[ \t]+)?INDEX[ \t]+/ && up !~ /INDEX[ \t]+CONCURRENTLY/) {
        tbl = index_table(raw, upraw)
        if (tbl != "" && !(table_key(tbl) in created)) {
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
            # Statements are matched as a whole: leading whitespace and the
            # line breaks of a multi-line statement are collapsed first.
            stmt_text = collapse(stmt)
            raw_text = collapse(raw)
            up = toupper(stmt_text)
            upraw = toupper(raw_text)
            if (up ~ /CREATE[ \t]+(UNIQUE[ \t]+)?INDEX[ \t]+CONCURRENTLY/) {
              concurrent_count++
              if (concurrent_line == 0) concurrent_line = stmt_line
              if (up ~ /CONCURRENTLY[ \t]+IF[ \t]+NOT[ \t]+EXISTS/) concurrent_if_not_exists = 1
            }
            if (up ~ /^CREATE[ \t]+TABLE[ \t]+/) {
              created[table_key(table_name(raw_text, upraw, "CREATE"))] = 1
            }
            analyse(up, raw_text)
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

section "Prerequisites"

missing_tools=""
for tool in awk sed grep mktemp; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools="${missing_tools} ${tool}"
done
if [ -n "$missing_tools" ]; then
  error "Required tool(s) not found on PATH:${missing_tools}. Install them and re-run the verification."
else
  echo "Required tools are available."
fi

if [ -n "$MIGRATION_BASE_REF" ] || [ "${CHECK_GIT_DIRTY:-false}" = "true" ]; then
  if ! command -v git >/dev/null 2>&1; then
    error "git is not installed but is required for the history checks. Install git or unset MIGRATION_BASE_REF."
  else
    echo "git is available."
  fi
fi

needs_prisma=false
if [ "${SKIP_SCHEMA_VALIDATION:-false}" != "true" ]; then
  needs_prisma=true
fi
if [ -n "$SHADOW_DATABASE_URL" ]; then
  needs_prisma=true
fi
if [ "$needs_prisma" = true ]; then
  if npx --no-install prisma --version >/dev/null 2>&1; then
    echo "Prisma CLI is available."
  else
    error "The Prisma CLI is not available. Run 'npm ci' (or 'npm install prisma') before verifying the migrations."
  fi
fi

# --- 1. static checks ------------------------------------------------------------

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

    # A migration that already exists on the base ref is applied on every
    # deployed database and cannot be changed any more: this pull request
    # cannot fix it. The advisories and the destructive-statement check
    # therefore only apply to migrations that are new relative to the base
    # ref. Without a base ref there is no way to tell them apart, so the
    # advisories are skipped and every destructive statement is rejected.
    already_merged=false
    if [ "$base_ref_state" = "resolved" ] && is_base_migration "$name"; then
      already_merged=true
    fi
    report_advisories=false
    if [ "$base_ref_state" = "resolved" ] && [ "$already_merged" = false ]; then
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
          elif [ "$already_merged" = true ]; then
            warn "Destructive statement in an already merged migration: ${message}. It is applied on deployed databases and cannot be changed any more; add a new migration instead" "$sql_file" "$line"
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

# --- 2. schema coverage ---------------------------------------------------------

section "Schema coverage"

if [ ! -f "$SCHEMA_PATH" ]; then
  echo "Skipping: no schema to compare against."
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
else
  work_dir="$(mktemp -d)"
  schema_facts_file="${work_dir}/schema.facts"
  migration_facts_file="${work_dir}/migrations.facts"

  schema_facts "$SCHEMA_PATH" > "$schema_facts_file"

  : > "$migration_facts_file"
  for name in ${migrations[@]+"${migrations[@]}"}; do
    sql_file="${MIGRATIONS_DIR}/${name}/migration.sql"
    [ -f "$sql_file" ] || continue
    migration_facts "$sql_file" "$name" >> "$migration_facts_file"
  done

  schema_models="$(grep -c '^MODEL' "$schema_facts_file" || true)"
  schema_enums="$(grep -c '^ENUM' "$schema_facts_file" || true)"
  schema_columns="$(grep -c '^COLUMN' "$schema_facts_file" || true)"
  echo "Schema declares ${schema_models} model(s), ${schema_enums} enum(s) and ${schema_columns} column(s)."

  drift_found=0
  while IFS=$'\t' read -r kind first second third; do
    case "$kind" in
      MISSING_TABLE)
        drift_found=1
        error "Model '${first}' (table \"${second}\") is declared in the schema but no migration creates it. The schema drifted from the migration history; generate one with: npx prisma migrate dev --name add_${first,,}" "$SCHEMA_PATH"
        ;;
      MISSING_COLUMN)
        drift_found=1
        error "Column \"${second}\".\"${third}\" of model '${first}' is declared in the schema but no migration creates it. The schema drifted from the migration history; generate one with: npx prisma migrate dev --name add_${first,,}" "$SCHEMA_PATH"
        ;;
      MISSING_ENUM)
        drift_found=1
        error "Enum '${first}' is declared in the schema but no migration creates it. The schema drifted from the migration history; generate one with: npx prisma migrate dev --name add_${first,,}" "$SCHEMA_PATH"
        ;;
    esac
  done < <(
    awk -F'\t' '
      FILENAME == ARGV[1] {
        if ($1 == "MODEL") { model_table[$2] = $3; models[$2] = 1 }
        else if ($1 == "ENUM") { schema_enums[$2] = 1 }
        else if ($1 == "COLUMN") { schema_columns[$2, $3] = 1 }
        next
      }
      FILENAME == ARGV[2] {
        if ($1 == "TABLE") { migration_tables[$2] = 1 }
        else if ($1 == "ENUM") { migration_enums[$2] = 1 }
        else if ($1 == "COLUMN") { migration_columns[$2, $3] = 1 }
        next
      }
      END {
        for (model in models) {
          table = model_table[model]
          if (!(table in migration_tables)) {
            missing_table[model] = 1
            printf "MISSING_TABLE\t%s\t%s\n", model, table
          }
        }
        for (key in schema_columns) {
          split(key, parts, SUBSEP)
          model = parts[1]
          if (model in missing_table) continue
          table = model_table[model]
          if (table == "") continue
          if (!((table, parts[2]) in migration_columns)) {
            printf "MISSING_COLUMN\t%s\t%s\t%s\n", model, table, parts[2]
          }
        }
        for (enum in schema_enums) {
          if (!(enum in migration_enums)) printf "MISSING_ENUM\t%s\n", enum
        }
      }
    ' "$schema_facts_file" "$migration_facts_file"
  )

  duplicate_tables="$(awk -F'\t' '$1 == "TABLE" { print $2 }' "$migration_facts_file" | sort | uniq -d)"
  if [ -n "$duplicate_tables" ]; then
    while IFS= read -r table; do
      [ -n "$table" ] || continue
      warn "Table \"${table}\" is created by more than one migration; the replay may fail. Review the migration history." "$MIGRATIONS_DIR"
    done <<< "$duplicate_tables"
  fi

  if [ "$drift_found" -eq 0 ]; then
    echo "Every model, enum and column of the schema is covered by the migration history."
  fi
  checks=$((checks + 1))
fi

# --- 3. history checks ---------------------------------------------------------

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
  for name in ${base_migrations[@]+"${base_migrations[@]}"}; do
    newest_base="$name"
    if [ ! -d "${MIGRATIONS_DIR}/${name}" ]; then
      error "Migration '${name}' exists on ${MIGRATION_BASE_REF} but was deleted; applied migrations must never be removed" "${MIGRATIONS_DIR}/${name}"
    elif ! git -C "$MIGRATIONS_DIR" diff --quiet "$base_commit" -- "${name}/migration.sql"; then
      error "Migration '${name}' already exists on ${MIGRATION_BASE_REF} and was modified. Databases that applied it will report a checksum mismatch; revert the edit and add a new migration instead" "${MIGRATIONS_DIR}/${name}/migration.sql"
    fi
  done

  new_count=0
  for name in ${migrations[@]+"${migrations[@]}"}; do
    is_on_base=false
    for base_name in ${base_migrations[@]+"${base_migrations[@]}"}; do
      if [ "$base_name" = "$name" ]; then
        is_on_base=true
        break
      fi
    done
    [ "$is_on_base" = true ] && continue
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
  checks=$((checks + 1))
fi

# --- 4. database checks --------------------------------------------------------

section "Database replay and drift"

if [ -z "$SHADOW_DATABASE_URL" ]; then
  echo "Skipping: set SHADOW_DATABASE_URL to a disposable database to replay migrations and detect schema drift."
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
elif [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" = "$SHADOW_DATABASE_URL" ]; then
  error "SHADOW_DATABASE_URL is identical to DATABASE_URL. The verification resets the database it is given, so it must point at a disposable database." "$MIGRATIONS_DIR"
else
  # Replays every migration, in order, on the (reset) shadow database, then
  # diffs the result against schema.prisma. Exit codes: 0 = no drift,
  # 2 = drift, anything else = a migration failed to apply.
  set +e
  diff_output="$(DATABASE_URL="$SHADOW_DATABASE_URL" npx --no-install prisma migrate diff \
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
      if printf '%s' "$diff_output" | grep -qiE "can't reach database|P1001|ECONNREFUSED|connection refused|connection timed out|server closed the connection"; then
        error "Could not reach the shadow database at ${SHADOW_DATABASE_URL}. Start PostgreSQL (or fix the connection string) and re-run: SHADOW_DATABASE_URL=... npm run db:verify" "$MIGRATIONS_DIR"
      else
        error "Replaying the migration history on an empty database failed (see output above). A migration has invalid SQL or depends on an object created by a later migration" "$MIGRATIONS_DIR"
      fi
      ;;
  esac

  # The deployment path itself: applying the whole history on an empty schema
  # must succeed and must leave no pending migration behind.
  set +e
  deploy_output="$(DATABASE_URL="$SHADOW_DATABASE_URL" npx --no-install prisma migrate reset --force --skip-seed --skip-generate 2>&1)"
  deploy_status=$?
  status_output="$(DATABASE_URL="$SHADOW_DATABASE_URL" npx --no-install prisma migrate status 2>&1)"
  set -e

  if [ "$deploy_status" -ne 0 ]; then
    echo "$deploy_output"
    error "Applying the migration history on an empty schema failed (see output above). The migration history cannot be applied by the deployment tooling" "$MIGRATIONS_DIR"
  else
    echo "The migration history applies cleanly on an empty schema."
    printf '%s\n' "$status_output" | sed 's/^/    /'
    if ! printf '%s' "$status_output" | grep -qi "up to date"; then
      warn "prisma migrate status did not report an up-to-date database; see the output above" "$MIGRATIONS_DIR"
    fi
  fi
  checks=$((checks + 1))
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
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Migration verification failed"
      echo
      echo "- errors: ${errors}"
      echo "- warnings: ${warnings}"
      echo
      echo "Re-run the verification locally with \`npm run db:verify\`."
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo "Migration verification passed with ${warnings} warning(s) (${checks} check group(s) executed)."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Migration verification passed"
    echo
    echo "- errors: 0"
    echo "- warnings: ${warnings}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
