#!/usr/bin/env bash
#
# Verifies the integrity of the Prisma migration history.
#
# Checks run in five tiers; each tier runs only when its inputs are available,
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
#        - destructive statements in new migrations are reported as warnings
#
#   4. Database (when SHADOW_DATABASE_URL is set; the database is RESET)
#        - the full history replays cleanly, in order, on an empty database,
#          which validates SQL syntax and cross-migration dependencies
#        - `prisma migrate deploy` applies the history and leaves no pending
#          migration, which validates the path operators actually run
#        - schema.prisma has no changes missing from the migration history
#
# Environment:
#   MIGRATIONS_DIR          migrations directory      (default: prisma/migrations)
#   SCHEMA_PATH             Prisma schema file        (default: prisma/schema.prisma)
#   MIGRATION_BASE_REF      git ref to compare against, e.g. origin/main
#   SHADOW_DATABASE_URL     disposable database for replay and drift checks
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

# --- SQL lexer ------------------------------------------------------------------

# Scans a migration.sql file, skipping comments and string/identifier/dollar-
# quoted literals, and prints one tab-separated finding per line:
#   E <line> <message>     lexical error
#   D <line> <statement>   destructive statement (reported for new migrations)
# Written for POSIX awk so it runs under mawk on ubuntu-latest.
lint_sql() {
  awk '
    BEGIN { state = "code"; depth = 0; open_stmt = 0; has_stmt = 0 }
    {
      sub(/\r$/, "")
      line = $0
      if (state == "code" && line ~ /^(<<<<<<<|=======|>>>>>>>)( |$)/) {
        printf "E\t%d\tunresolved merge-conflict marker\n", NR
        next
      }
      code = ""
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
            if (substr(line, i + 1, 1) == "\047") { i += 2; continue }
            state = "code"
          }
          i++
          continue
        }
        if (state == "dquote") {
          if (c == "\"") { state = "code" }
          i++
          continue
        }
        if (state == "dollar") {
          if (substr(line, i, length(tag)) == tag) { state = "code"; i += length(tag) } else { i++ }
          continue
        }

        # state == "code"
        if (c2 == "--") { break }
        if (c2 == "/*") { state = "block"; opened = NR; i += 2; continue }
        if (c != " " && c != "\t" && c != ";") { open_stmt = 1; has_stmt = 1; last = NR }
        if (c == "\047") { state = "squote"; opened = NR; code = code "\047\047"; i++; continue }
        if (c == "\"") { state = "dquote"; opened = NR; code = code "\"\""; i++; continue }
        if (c == "$" && match(substr(line, i), /^\$[A-Za-z_]*\$/)) {
          tag = substr(line, i, RLENGTH); state = "dollar"; opened = NR; i += RLENGTH
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
          open_stmt = 0
        }
        code = code c
        i++
      }

      upper = toupper(code)
      if (upper ~ /DROP[ \t]+(TABLE|COLUMN|SCHEMA|TYPE|VIEW)/ ||
          upper ~ /TRUNCATE[ \t]/ ||
          upper ~ /DELETE[ \t]+FROM/ ||
          upper ~ /ALTER[ \t]+COLUMN.*[ \t]TYPE[ \t]/ ||
          upper ~ /SET[ \t]+NOT[ \t]+NULL/ ||
          upper ~ /RENAME[ \t]+(TO|COLUMN)/) {
        stmt = line
        gsub(/^[ \t]+|[ \t]+$/, "", stmt)
        printf "D\t%d\t%s\n", NR, stmt
      }
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
      if (!has_stmt) {
        printf "E\t1\tcontains no SQL statements (only comments or whitespace)\n"
      } else if (open_stmt && state == "code") {
        printf "E\t%d\tfinal statement is not terminated with \";\"\n", last
      }
    }
  ' "$1"
}

# --- schema / migration fact extraction ----------------------------------------

# Prints the models, enums and columns declared in a Prisma schema, one fact
# per line:
#   MODEL  <model>  <table>
#   ENUM   <enum>
#   COLUMN <model>  <column>
schema_facts() {
  local model_names
  model_names="$(awk '
    /^model[ \t]+/ { name = $2; sub(/\{.*/, "", name); print name }
  ' "$1" | tr '\n' ',')"

  awk -v models="$model_names" '
    function quoted(s) {
      if (match(s, /"[^"]*"/)) return substr(s, RSTART + 1, RLENGTH - 2)
      return ""
    }
    function is_model(type) {
      for (i = 1; i <= model_count; i++) if (model_list[i] == type) return 1
      return 0
    }
    BEGIN { model_count = split(models, model_list, ",") }
    /^[ \t]*\/\// { next }
    /^model[ \t]+/ {
      name = $2
      sub(/\{.*/, "", name)
      model = name
      in_model = 1
      mapped = name
      ignored = 0
      next
    }
    /^enum[ \t]+/ {
      name = $2
      sub(/\{.*/, "", name)
      print "ENUM\t" name
      in_model = 0
      next
    }
    /^[ \t]*\}[ \t]*$/ {
      if (in_model) {
        if (!ignored) {
          print "MODEL\t" model "\t" mapped
          for (c in cols) {
            split(c, parts, SUBSEP)
            if (parts[1] == model) print "COLUMN\t" model "\t" parts[2]
          }
        }
        delete cols
      }
      in_model = 0
      next
    }
    in_model {
      line = $0
      if (line ~ /^[ \t]*@@/) {
        if (match(line, /@@map\("[^"]+"\)/)) {
          mapped = quoted(substr(line, RSTART, RLENGTH))
        }
        if (line ~ /@@ignore/) { ignored = 1 }
        next
      }
      if (line !~ /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]+/) { next }
      field = $1
      type = $2
      sub(/\[\]$/, "", type)
      sub(/\?$/, "", type)
      if (line ~ /@ignore/) { next }
      if (line ~ /Unsupported\(/) { next }
      if (is_model(type)) {
        # A relation field does not declare a column of its own: the foreign
        # key is either listed in `fields: [...]` (a scalar field of this
        # model) or lives on the other side of the relation.
        if (match(line, /fields:[[:space:]]*\[[^]]*\]/)) {
          list = substr(line, RSTART, RLENGTH)
          gsub(/fields:[[:space:]]*\[/, "", list)
          gsub(/\]/, "", list)
          count = split(list, refs, ",")
          for (i = 1; i <= count; i++) {
            gsub(/[ \t]/, "", refs[i])
            if (refs[i] != "") cols[model, refs[i]] = 1
          }
        }
        next
      }
      column = field
      if (match(line, /@map\("[^"]+"\)/)) {
        column = quoted(substr(line, RSTART, RLENGTH))
      }
      cols[model, column] = 1
      next
    }
  ' "$1"
}

# Prints the tables, enums and columns the migration history creates, one fact
# per line:
#   TABLE  <table>  <migration>
#   ENUM   <enum>
#   COLUMN <table>  <column>
# The SQL is split into statements with a small lexer so that semicolons inside
# strings, comments or dollar-quoted bodies do not split a statement.
migration_facts() {
  awk -v migration="$2" '
    function quoted(s) {
      if (match(s, /"[^"]*"/)) return substr(s, RSTART + 1, RLENGTH - 2)
      return ""
    }
    # Splits the body of a CREATE TABLE into its definitions. Only commas at
    # the top level separate them, so `DECIMAL(30,7)` stays in one piece.
    function split_definitions(body, count,   depth, current, i, c) {
      count = 0
      depth = 0
      current = ""
      n = length(body)
      for (i = 1; i <= n; i++) {
        c = substr(body, i, 1)
        if (c == "(") depth++
        else if (c == ")") depth--
        if (c == "," && depth == 0) {
          definitions[++count] = current
          current = ""
          continue
        }
        current = current c
      }
      if (current != "") definitions[++count] = current
      return count
    }
    function process(s) {      if (match(s, /CREATE[ \t]+TABLE[ \t]+"[^"]+"/)) {
        table = quoted(substr(s, RSTART, RLENGTH))
        tables[table] = 1
        table_migration[table] = migration
        rest = substr(s, RSTART + RLENGTH)
        open = index(rest, "(")
        if (open > 0) {
          depth = 0
          closing = 0
          for (i = open; i <= length(rest); i++) {
            c = substr(rest, i, 1)
            if (c == "(") depth++
            else if (c == ")") {
              depth--
              if (depth == 0) { closing = i; break }
            }
          }
          if (closing > open) {
            body = substr(rest, open + 1, closing - open - 1)
            count = split_definitions(body)
            for (i = 1; i <= count; i++) {
              definition = definitions[i]
              gsub(/^[ \t\r\n]+|[ \t\r\n]+$/, "", definition)
              # A column definition starts with its quoted name; constraints
              # (CONSTRAINT, PRIMARY KEY, UNIQUE, FOREIGN KEY) do not.
              if (match(definition, /^"[^"]+"/)) {
                column = quoted(definition)
                columns[table, column] = 1
              }
            }
          }
        }
        return
      }
      if (match(s, /CREATE[ \t]+TYPE[ \t]+"[^"]+"/)) {
        enums[quoted(substr(s, RSTART, RLENGTH))] = 1
        return
      }
      if (match(s, /ALTER[ \t]+TABLE[ \t]+"[^"]+"/)) {
        table = quoted(substr(s, RSTART, RLENGTH))
        if (match(s, /RENAME[ \t]+TO[ \t]+"[^"]+"/)) {
          renamed = quoted(substr(s, RSTART, RLENGTH))
          tables[renamed] = 1
          table_migration[renamed] = migration
          # Copy the columns of the old name before renaming it.
          for (key in columns) {
            split(key, parts, SUBSEP)
            if (parts[1] == table) renamed_columns[parts[2]] = 1
          }
          for (column in renamed_columns) columns[renamed, column] = 1
          delete renamed_columns
          table = renamed
        }
        rest = s
        while (match(rest, /ADD[ \t]+COLUMN[ \t]+"[^"]+"/)) {
          column = quoted(substr(rest, RSTART, RLENGTH))
          columns[table, column] = 1
          rest = substr(rest, RSTART + RLENGTH)
        }
        return
      }
    }
    BEGIN { state = "code"; statement = "" }
    {
      line = $0
      sub(/\r$/, "", line)
      n = length(line)
      i = 1
      terminator = 0
      while (i <= n) {
        c = substr(line, i, 1)
        c2 = substr(line, i, 2)
        if (state == "block") {
          if (c2 == "*/") { state = "code"; i += 2 } else { i++ }
          continue
        }
        if (state == "squote") {
          if (c == "\047") {
            if (substr(line, i + 1, 1) == "\047") { i += 2; continue }
            state = "code"
          }
          i++
          continue
        }
        if (state == "dquote") {
          if (c == "\"") { state = "code" }
          i++
          continue
        }
        if (state == "dollar") {
          if (substr(line, i, length(tag)) == tag) { state = "code"; i += length(tag) } else { i++ }
          continue
        }
        if (c2 == "--") { break }
        if (c2 == "/*") { state = "block"; i += 2; continue }
        if (c == "\047") { state = "squote"; i++; continue }
        if (c == "\"") { state = "dquote"; i++; continue }
        if (c == "$" && match(substr(line, i), /^\$[A-Za-z_]*\$/)) {
          tag = substr(line, i, RLENGTH); state = "dollar"; i += RLENGTH; continue
        }
        if (c == ";") { terminator = i; break }
        i++
      }
      if (terminator > 0) {
        flush_statement = statement substr(line, 1, terminator - 1)
        process(flush_statement)
        statement = substr(line, terminator + 1)
      } else {
        statement = statement line "\n"
      }
    }
    END {
      if (statement != "") process(statement)
      for (table in tables) print "TABLE\t" table "\t" table_migration[table]
      for (enum in enums) print "ENUM\t" enum
      for (key in columns) {
        split(key, parts, SUBSEP)
        print "COLUMN\t" parts[1] "\t" parts[2]
      }
    }
  ' "$1"
}

# --- 0. prerequisites -----------------------------------------------------------

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
    elif [ -n "$schema_provider" ] && [ "$lock_provider" != "$schema_provider" ]; then
      error "migration_lock.toml provider \"${lock_provider}\" does not match the schema datasource provider \"${schema_provider}\"" "$lock_file"
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

    for extra in "$entry"/* "$entry"/.[!.]*; do
      [ -e "$extra" ] || continue
      [ "$(basename "$extra")" = "migration.sql" ] && continue
      warn "Unexpected file '$(basename "$extra")' in migration folder; Prisma only applies migration.sql" "$entry"
    done

    while IFS=$'\t' read -r kind line message; do
      [ "$kind" = "E" ] && error "Invalid SQL: ${message}" "$sql_file" "$line"
    done < <(lint_sql "$sql_file")
  done

  echo "Inspected ${#migrations[@]} migration folder(s)."
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
elif [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Skipping: no migrations directory."
elif ! base_commit="$(git -C "$MIGRATIONS_DIR" merge-base "$MIGRATION_BASE_REF" HEAD 2>/dev/null)"; then
  warn "Skipping history checks: cannot resolve a merge base with '${MIGRATION_BASE_REF}' (is the ref fetched? CI needs fetch-depth: 0)"
else
  echo "Comparing against ${MIGRATION_BASE_REF} (merge base ${base_commit:0:12})."

  # Folder names are passed relative to MIGRATIONS_DIR, so git resolves them
  # regardless of where the repository root is.
  base_migrations=()
  while IFS= read -r name; do
    [ -n "$name" ] && base_migrations+=("$name")
  done < <(git -C "$MIGRATIONS_DIR" ls-tree -d --name-only "$base_commit" ./ | sed 's#.*/##' | sort)

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
    new_count=$((new_count + 1))
    echo "New migration: ${name}"

    if [ -n "$newest_base" ] && [[ ! "$name" > "$newest_base" ]]; then
      error "New migration '${name}' sorts before '${newest_base}', the newest migration on ${MIGRATION_BASE_REF}; Prisma would apply it out of order. Regenerate it with a current timestamp" "${MIGRATIONS_DIR}/${name}"
    fi

    sql_file="${MIGRATIONS_DIR}/${name}/migration.sql"
    [ -f "$sql_file" ] || continue
    while IFS=$'\t' read -r kind line statement; do
      [ "$kind" = "D" ] && warn "Potentially destructive statement; confirm it is intended and that existing data is migrated: ${statement}" "$sql_file" "$line"
    done < <(lint_sql "$sql_file")
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
fi

# --- working tree ------------------------------------------------------------

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
