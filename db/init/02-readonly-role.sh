#!/usr/bin/env bash
# Security Layer 1 for the bundled Northwind demo.
#
# Uses the same generic script anyone runs on their own database
# (scripts/create-readonly-role.sql), so it is exercised on every rebuild,
# then adds hardening that is only appropriate on a database AskDB owns.
#
# Runs once, after 01-northwind.sql, when the database volume is first created.

set -euo pipefail

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v role=askdb_readonly \
     -v password="$ASKDB_READONLY_PASSWORD" \
     -v hide_columns='employees.birth_date,employees.address,employees.region,employees.postal_code,employees.home_phone,employees.photo,employees.notes,employees.photo_path' \
     -v harden_functions=on \
     -f /askdb/create-readonly-role.sql

# Demo-only lockdown: on a database AskDB owns, nobody else may connect or create objects.
# (Not part of the generic script, because on a shared database it would affect other users.)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
REVOKE ALL ON DATABASE northwind FROM PUBLIC;
GRANT CONNECT ON DATABASE northwind TO askdb_readonly;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL

echo "askdb_readonly role created."
