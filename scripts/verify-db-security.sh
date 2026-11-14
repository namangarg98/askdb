#!/usr/bin/env bash
# Proves Security Layer 1 for ANY PostgreSQL database: tries allowed and
# forbidden actions as AskDB's read-only role and reports PASS/FAIL for each.
#
# Usage: ./scripts/verify-db-security.sh              (reads .env, needs `psql` installed)
#        ./scripts/verify-db-security.sh --db shop    (reads .env.shop first, like `npm run dev -- --db shop`)
#
# Connection: DB_HOST, DB_PORT, DB_NAME, DB_READONLY_USER, ASKDB_READONLY_PASSWORD
# (defaults match the bundled Northwind demo).
# Hidden columns are found automatically (every column the role cannot read is tested).
# Optional: ASKDB_HIDDEN_COLUMNS="table.col,..." also fails the check if one of those is readable,
# and ASKDB_SENSITIVE_NAMES (a regex) changes which readable column names get a warning.
#
# Safe on real data: every write attempt runs inside BEGIN ... ROLLBACK, so even
# a misconfigured role cannot change anything; such a case is reported as FAIL.

set -uo pipefail
cd "$(dirname "$0")/.."

# --db <name>: load .env.<name> first; its values win over .env (same rule as the server).
if [ "${1:-}" = "--db" ] || [[ "${1:-}" == --db=* ]]; then
  if [ "$1" = "--db" ]; then PROFILE="${2:-}"; else PROFILE="${1#--db=}"; fi
  if ! [[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || [ ! -f ".env.$PROFILE" ]; then
    echo "--db: settings file .env.$PROFILE not found (use letters, digits, - or _)" >&2
    exit 1
  fi
  set -a; source ".env.$PROFILE"; set +a
fi

# Load .env, but let variables already set win
# (e.g. DB_NAME=shop ./scripts/verify-db-security.sh, or values from --db).
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -z "${!key+x}" ] && export "$key=$value"
  done < .env
fi

HOST="${DB_HOST:-127.0.0.1}"
PORT="${DB_PORT:-5433}"
DB="${DB_NAME:-northwind}"
ROLE="${DB_READONLY_USER:-askdb_readonly}"
SCHEMA="public"  # AskDB reads the public schema only
SSLMODE="${PGSSLMODE:-prefer}"
SENSITIVE_NAMES="${ASKDB_SENSITIVE_NAMES:-email|password|passwd|token|secret|api_?key|ssn|social_security|tax_id|phone|address|birth|salary|credit_card|card_number|iban}"

passed=0
failed=0
warned=0

# Runs SQL as the read-only role over TCP with a password, the same way the AskDB server connects.
run_sql() {
  PGPASSWORD="$ASKDB_READONLY_PASSWORD" PGSSLMODE="$SSLMODE" \
    psql -h "$HOST" -p "$PORT" -U "$ROLE" -d "$DB" -v ON_ERROR_STOP=1 -qtAX -c "$1" 2>/dev/null
}

expect_allowed() {
  if run_sql "$2" >/dev/null; then echo "PASS  allowed: $1"; passed=$((passed + 1))
  else echo "FAIL  should be allowed: $1"; failed=$((failed + 1)); fi
}

# Write attempts are wrapped in a transaction that is always rolled back. A failure only
# counts as "blocked" when PostgreSQL says why: a permission or read-only error. Any other
# error (e.g. a NOT NULL violation) could hide a privilege the role should not have.
BLOCKED_ERRORS='permission denied|read-only transaction|must be owner|must be superuser'
# Returns 0 if blocked, 1 if it ran, 2 if it failed for another reason (first error line in $probe_error).
probe_blocked() {
  local output
  if output=$(PGPASSWORD="$ASKDB_READONLY_PASSWORD" PGSSLMODE="$SSLMODE" \
      psql -h "$HOST" -p "$PORT" -U "$ROLE" -d "$DB" -v ON_ERROR_STOP=1 -qtAX -c "BEGIN; $1; ROLLBACK;" 2>&1); then
    return 1
  elif echo "$output" | grep -Eqi "$BLOCKED_ERRORS"; then
    return 0
  fi
  probe_error=$(echo "$output" | head -1)
  return 2
}

expect_blocked() {
  probe_blocked "$2"
  case $? in
    0) [ "${3:-}" = quiet ] || echo "PASS  blocked: $1"; passed=$((passed + 1)) ;;
    1) echo "FAIL  was NOT blocked: $1"; failed=$((failed + 1)) ;;
    *) echo "FAIL  failed for another reason, privilege unclear: $1 ($probe_error)"; failed=$((failed + 1)) ;;
  esac
}

# For hardening that managed services may not allow: a gap is a warning, not a failure.
expect_blocked_or_warn() {
  if run_sql "$2" >/dev/null; then echo "WARN  not blocked by the database: $1 (the SQL guard still blocks it)"; warned=$((warned + 1))
  else echo "PASS  blocked: $1"; passed=$((passed + 1)); fi
}

echo "Checking role \"$ROLE\" on $HOST:$PORT/$DB (schema $SCHEMA)"
echo

if ! run_sql "SELECT 1" >/dev/null; then
  echo "Cannot connect as $ROLE. Is the database running, and are the connection settings right?" >&2
  exit 1
fi

# Pick a table and column the role can read, to aim the write attempts at.
TABLE=$(run_sql "SELECT table_name FROM information_schema.tables WHERE table_schema = '$SCHEMA' AND table_type = 'BASE TABLE' ORDER BY table_name LIMIT 1")
COLUMN=$(run_sql "SELECT column_name FROM information_schema.columns WHERE table_schema = '$SCHEMA' AND table_name = '$TABLE' ORDER BY ordinal_position LIMIT 1")
if [ -z "$TABLE" ]; then
  echo "The role cannot see any table in schema $SCHEMA. Did create-readonly-role.sql run?" >&2
  exit 1
fi
T="\"$SCHEMA\".\"$TABLE\""
C="\"$COLUMN\""

expect_allowed "read $TABLE"                       "SELECT count(*) FROM $T"
expect_blocked "insert into $TABLE"                "INSERT INTO $T DEFAULT VALUES"
expect_blocked "update $TABLE"                     "UPDATE $T SET $C = $C"
expect_blocked "delete from $TABLE"                "DELETE FROM $T"
expect_blocked "truncate $TABLE"                   "TRUNCATE $T"
expect_blocked "drop $TABLE"                       "DROP TABLE $T"
expect_blocked "create a table"                    "CREATE TABLE \"$SCHEMA\".askdb_probe (id int)"
expect_blocked "write after forcing READ WRITE"    "SET TRANSACTION READ WRITE; DELETE FROM $T"
expect_blocked "hidden write inside a CTE"         "WITH d AS (DELETE FROM $T RETURNING 1) SELECT count(*) FROM d"
expect_blocked "read a server file"                "SELECT pg_read_file('/etc/passwd')"
expect_blocked "read password hashes"              "SELECT rolpassword FROM pg_authid"

# Hidden columns: the ones listed in ASKDB_HIDDEN_COLUMNS (a readable one is a FAIL), plus
# every column the database says this role cannot read (found automatically).
AUTO_HIDDEN=$(run_sql "SELECT c.relname || '.' || a.attname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = '$SCHEMA' AND c.relkind IN ('r', 'v', 'm', 'p')
    AND has_any_column_privilege(c.oid, 'SELECT')
    AND NOT has_column_privilege(c.oid, a.attnum, 'SELECT')")
HIDDEN_LIST=$( { echo "$AUTO_HIDDEN"; echo "${ASKDB_HIDDEN_COLUMNS:-}" | tr ',' '\n'; } \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' | sort -u)
hidden_total=$(echo "$HIDDEN_LIST" | grep -c . || true)
# With many hidden columns, list only failures and summarise the passes in one line.
mode=""; [ "$hidden_total" -gt 10 ] && mode=quiet
passed_before=$passed
while IFS= read -r item; do
  [ -z "$item" ] && continue
  expect_blocked "read hidden column $item" "SELECT \"${item#*.}\" FROM \"$SCHEMA\".\"${item%%.*}\"" $mode
done <<< "$HIDDEN_LIST"
[ -n "$mode" ] && echo "PASS  blocked: $((passed - passed_before)) of $hidden_total hidden columns unreadable"
[ "$hidden_total" -eq 0 ] && echo "INFO  no hidden columns: the role can read every column of its tables"

# Safety net for a forgotten column: readable columns whose names look personal or secret
# (columns ending in _id are skipped: they are keys such as address_id, not personal data).
SENSITIVE=$(run_sql "SELECT table_name || '.' || column_name FROM information_schema.columns
  WHERE table_schema = '$SCHEMA' AND column_name ~* '$SENSITIVE_NAMES'
    AND column_name !~* '_id$' ORDER BY table_name, ordinal_position")
sensitive_total=$(echo "$SENSITIVE" | grep -c . || true)
if [ "$sensitive_total" -gt 0 ]; then
  shown=$(echo "$SENSITIVE" | head -15 | paste -sd ',' - | sed 's/,/, /g')
  [ "$sensitive_total" -gt 15 ] && shown="$shown, and $((sensitive_total - 15)) more"
  echo "WARN  $sensitive_total readable columns have sensitive-looking names; hide any that hold personal data"
  echo "      (hide_columns or hide_patterns): $shown"
  warned=$((warned + 1))
fi

expect_blocked_or_warn "pg_sleep stall"            "SELECT pg_sleep(0.1)"
expect_blocked_or_warn "set_config to lift limits" "SELECT set_config('statement_timeout', '0', false)"

# Database isolation, when AskDB's own database is on the same server (the bundled setup).
META_HOST="${META_DB_HOST:-$HOST}"
META_PORT="${META_DB_PORT:-$PORT}"
if [ "$META_HOST" = "$HOST" ] && [ "$META_PORT" = "$PORT" ] && [ -n "${ASKDB_APP_PASSWORD:-}" ]; then
  if PGPASSWORD="$ASKDB_READONLY_PASSWORD" psql -h "$HOST" -p "$PORT" -U "$ROLE" -d "${DB_META_NAME:-askdb_meta}" -qtAX -c "SELECT 1" >/dev/null 2>&1; then
    echo "FAIL  was NOT blocked: read-only role opening AskDB's own database"; failed=$((failed + 1))
  else
    echo "PASS  blocked: read-only role opening AskDB's own database"; passed=$((passed + 1))
  fi
fi

echo
echo "$passed passed, $failed failed, $warned warnings"
[ "$failed" -eq 0 ]
