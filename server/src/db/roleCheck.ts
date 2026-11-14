import type pg from 'pg';
import { UnsafeDatabaseRoleError } from '../errors.js';

/** Built-in roles that would undo Layer 1: read hidden columns, write data, or touch server files. */
const DANGEROUS_BUILT_IN_ROLES = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
];
const MAX_TABLES_LISTED = 10;

/**
 * Checks, as the connected role, that Layer 1 is really in place: the role is not an
 * administrator, cannot change any table, and is not a member of a built-in role that
 * bypasses column grants or reaches the server's files. Returns the problems found
 * (empty when the role is safe).
 */
export async function findRoleProblems(pool: pg.Pool): Promise<string[]> {
  const role = await pool.query<{
    name: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = current_user`,
  );
  const attributes = role.rows[0];
  if (!attributes) return ['the connected role could not be found in pg_roles'];
  if (attributes.rolsuper) return [`role "${attributes.name}" is a superuser`];

  const problems: string[] = [];
  const powers: [boolean, string][] = [
    [attributes.rolcreaterole, 'CREATEROLE'],
    [attributes.rolcreatedb, 'CREATEDB'],
    [attributes.rolreplication, 'REPLICATION'],
    [attributes.rolbypassrls, 'BYPASSRLS'],
  ];
  for (const [has, power] of powers) {
    if (has) problems.push(`role "${attributes.name}" has ${power}`);
  }

  const memberships = await pool.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles
     WHERE rolname = ANY ($1) AND pg_has_role(current_user, oid, 'MEMBER')
     ORDER BY rolname`,
    [DANGEROUS_BUILT_IN_ROLES],
  );
  for (const { rolname } of memberships.rows) {
    problems.push(`role "${attributes.name}" is a member of ${rolname}`);
  }

  // Any write privilege, on any table or view in any non-system schema, including through role membership.
  const writable = await pool.query<{ name: string; privileges: string[] }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name,
            array_remove(ARRAY[
              CASE WHEN has_any_column_privilege(c.oid, 'INSERT') THEN 'INSERT' END,
              CASE WHEN has_any_column_privilege(c.oid, 'UPDATE') THEN 'UPDATE' END,
              CASE WHEN has_table_privilege(c.oid, 'DELETE') THEN 'DELETE' END,
              CASE WHEN has_table_privilege(c.oid, 'TRUNCATE') THEN 'TRUNCATE' END
            ], NULL) AS privileges
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
       AND (has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE')
            OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
     ORDER BY 1`,
  );
  if (writable.rows.length > 0) {
    const listed = writable.rows
      .slice(0, MAX_TABLES_LISTED)
      .map((row) => `${row.name} (${row.privileges.join(', ')})`)
      .join(', ');
    const more = writable.rows.length > MAX_TABLES_LISTED ? `, and ${writable.rows.length - MAX_TABLES_LISTED} more` : '';
    problems.push(`role "${attributes.name}" can change ${writable.rows.length} table(s): ${listed}${more}`);
  }

  return problems;
}

/** Refuses to continue when the database role could write or bypass column grants (fails closed). */
export async function assertSafeDatabaseRole(pool: pg.Pool): Promise<void> {
  const problems = await findRoleProblems(pool);
  if (problems.length > 0) throw new UnsafeDatabaseRoleError(problems);
}
