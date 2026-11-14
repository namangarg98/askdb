-- Security Layer 1 for ANY PostgreSQL database: creates (or updates) the
-- restricted role AskDB uses to run AI-generated SQL.
--
-- Run it as a user that can create roles and grant on the target schema,
-- connected to the database AskDB should query:
--
--   psql "host=... port=5432 dbname=shop user=admin" \
--     -v password='a-long-random-password' \
--     -f scripts/create-readonly-role.sql
--
-- Optional variables (-v name=value):
--   role              role name                                  (default askdb_readonly)
--   only_tables       allow-list: grant ONLY these tables        e.g. 'orders,order_items,products'
--                     (default: every table in the schema)
--   hide_tables       comma list of tables to hide entirely      e.g. 'audit_events,api_keys'
--   hide_columns      comma list of table.column to hide         e.g. 'users.email,users.password_hash'
--   hide_patterns     hide every column whose name matches, in every table (SQL LIKE, case-insensitive)
--                     e.g. '%email%,%password%,%token%,%secret%,%phone%,%address%,%birth%'
--   dry_run           'on' prints what would be readable and hidden, and changes nothing
--   harden_functions  'on' revokes pg_sleep* and set_config from PUBLIC. This affects EVERY
--                     role in the database, so it is off by default; AskDB's SQL guard and
--                     statement timeout block these functions either way.
--
-- Safe to re-run, e.g. after adding tables or columns: the role's table privileges are reset
-- and granted again from the options given, so the result always matches the latest run.
-- Other users of the database are not changed (apart from harden_functions=on).

\set ON_ERROR_STOP on

\if :{?password}
\else
  \echo 'Missing password. Run with: -v password=...'
  \quit
\endif
\if :{?role}
\else
  \set role askdb_readonly
\endif
-- AskDB reads the public schema only (multi-schema support is not built), so it is fixed here.
\set schema public
\if :{?only_tables}
\else
  \set only_tables ''
\endif
\if :{?hide_tables}
\else
  \set hide_tables ''
\endif
\if :{?hide_columns}
\else
  \set hide_columns ''
\endif
\if :{?hide_patterns}
\else
  \set hide_patterns ''
\endif
\if :{?dry_run}
\else
  \set dry_run off
\endif
\if :{?harden_functions}
\else
  \set harden_functions off
\endif

SELECT current_database() AS db \gset

-- 0. Stop on typos: a misspelled name in hide_* would silently leave data readable.
SELECT format('DO $fail$ BEGIN RAISE EXCEPTION %L; END $fail$',
              'Not found in schema ' || :'schema' || ': ' || string_agg(name, ', '))
FROM (
  SELECT trim(x) AS name FROM unnest(string_to_array(:'only_tables' || ',' || :'hide_tables', ',')) x
  WHERE trim(x) <> ''
    AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = :'schema' AND c.relname = trim(x) AND c.relkind IN ('r', 'v', 'm', 'p'))
  UNION ALL
  SELECT trim(x) FROM unnest(string_to_array(:'hide_columns', ',')) x
  WHERE trim(x) <> ''
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = :'schema'
                      AND table_name = split_part(trim(x), '.', 1)
                      AND column_name = split_part(trim(x), '.', 2))
) missing
HAVING count(*) > 0 \gexec

-- 1. Work out the tables the role may read, and the columns to hide in them.
SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '') AS scope_tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'schema' AND c.relkind IN ('r', 'v', 'm', 'p')
  AND (:'only_tables' = ''
       OR c.relname IN (SELECT trim(x) FROM unnest(string_to_array(:'only_tables', ',')) x))
  AND c.relname NOT IN (SELECT trim(x) FROM unnest(string_to_array(:'hide_tables', ',')) x) \gset

SELECT coalesce(string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, ordinal_position), '')
       AS hidden_columns_all
FROM information_schema.columns
WHERE table_schema = :'schema'
  AND table_name = ANY (string_to_array(:'scope_tables', ','))
  AND ((table_name || '.' || column_name) IN (SELECT trim(x) FROM unnest(string_to_array(:'hide_columns', ',')) x)
       OR column_name ILIKE ANY (SELECT trim(x) FROM unnest(string_to_array(:'hide_patterns', ',')) x
                                 WHERE trim(x) <> '')) \gset

\if :dry_run
  \echo
  \echo 'Dry run: nothing was changed. With these options the role could read:'
  SELECT t AS table_name,
         coalesce((SELECT string_agg(split_part(h, '.', 2), ', ')
                   FROM unnest(string_to_array(:'hidden_columns_all', ',')) h
                   WHERE split_part(h, '.', 1) = t), '') AS hidden_columns
  FROM unnest(string_to_array(:'scope_tables', ',')) t
  ORDER BY 1;
  \quit
\endif

-- 2. A login role with no special powers and a small connection cap.
SELECT format('CREATE ROLE %I', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec

ALTER ROLE :"role" WITH LOGIN PASSWORD :'password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;

-- 3. Safe session defaults (defaults, not walls: the privileges below are the walls).
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '5s';
ALTER ROLE :"role" SET lock_timeout = '1s';
ALTER ROLE :"role" SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE :"role" SET search_path = :"schema";

-- 4. Connect, and read (never write) exactly the tables in scope. Privileges from earlier
--    runs are reset first, so tables or columns removed from the options become unreadable.
GRANT CONNECT ON DATABASE :"db" TO :"role";
GRANT USAGE ON SCHEMA :"schema" TO :"role";
REVOKE ALL ON ALL TABLES IN SCHEMA :"schema" FROM :"role";

SELECT format('GRANT SELECT ON %s TO %I',
              string_agg(format('%I.%I', :'schema', t), ', '), :'role')
FROM unnest(string_to_array(:'scope_tables', ',')) t
HAVING count(*) > 0 \gexec

-- 5. Hide columns: revoke the table, then grant every column except the hidden ones.
--    (A table whose columns are all hidden ends up unreadable.)
WITH hidden AS (
  SELECT split_part(h, '.', 1) AS table_name, split_part(h, '.', 2) AS column_name
  FROM unnest(string_to_array(:'hidden_columns_all', ',')) h
)
SELECT format('REVOKE SELECT ON %I.%I FROM %I', :'schema', t.table_name, :'role')
FROM (SELECT DISTINCT table_name FROM hidden) t \gexec

WITH hidden AS (
  SELECT split_part(h, '.', 1) AS table_name, split_part(h, '.', 2) AS column_name
  FROM unnest(string_to_array(:'hidden_columns_all', ',')) h
)
SELECT format('GRANT SELECT (%s) ON %I.%I TO %I',
              string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position),
              :'schema', c.table_name, :'role')
FROM information_schema.columns c
WHERE c.table_schema = :'schema'
  AND c.table_name IN (SELECT table_name FROM hidden)
  AND (c.table_name, c.column_name) NOT IN (SELECT table_name, column_name FROM hidden)
GROUP BY c.table_name \gexec

-- 6. Optional: block functions a crafted SELECT could abuse, for everyone in this database.
\if :harden_functions
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION pg_sleep(double precision) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_sleep_for(interval) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_sleep_until(timestamp with time zone) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION set_config(text, text, boolean) FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  -- Managed services (RDS, Neon, ...) do not allow this; the SQL guard still blocks these functions.
  RAISE WARNING 'Could not revoke pg_sleep/set_config (needs superuser); relying on the SQL guard and timeouts';
END
$$;
\endif

\echo
\echo 'Read-only role ready. Tables it can read, and the columns hidden from it:'
SELECT c.relname AS table_name,
       coalesce((SELECT string_agg(a.attname, ', ' ORDER BY a.attnum)
                 FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                   AND NOT has_column_privilege(:'role', c.oid, a.attnum, 'SELECT')), '') AS hidden_columns
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'schema' AND c.relkind IN ('r', 'v', 'm', 'p')
  AND has_any_column_privilege(:'role', c.oid, 'SELECT')
ORDER BY 1;
