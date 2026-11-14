#!/usr/bin/env bash
# AskDB's own storage, kept separate from the data being queried.
#
# Creates the `askdb_meta` database (schema index, audit log, saved history),
# owned by `askdb_app`. The read-only role that runs AI-generated SQL cannot
# connect to it, and `askdb_app` cannot connect to `northwind`.
#
# Runs once, after 02-readonly-role.sh, when the database volume is first created.

set -euo pipefail

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v app_password="$ASKDB_APP_PASSWORD" <<'EOSQL'

CREATE ROLE askdb_app WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5;

CREATE DATABASE askdb_meta OWNER askdb_app;
REVOKE ALL ON DATABASE askdb_meta FROM PUBLIC;

EOSQL

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname askdb_meta <<'EOSQL'

-- Installing an extension needs the admin. The tables (schema_docs, audit_log)
-- are created by the AskDB server itself, owned by askdb_app.
CREATE EXTENSION IF NOT EXISTS vector;

EOSQL

echo "askdb_meta database created."
