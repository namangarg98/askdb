/**
 * Reads the database structure AS THE READ-ONLY ROLE.
 *
 * PostgreSQL's information_schema only lists columns the current role may
 * read, so columns hidden by Layer 1 (e.g. employees.home_phone) never appear
 * here, and therefore never reach Claude. Keys come from pg_catalog and are
 * filtered to visible columns and allowed tables for the same reason.
 */
import type pg from 'pg';

export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
}

export interface ForeignKeyInfo {
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
}

export interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

interface ConstraintRow {
  table_name: string;
  contype: 'p' | 'f';
  columns: string[];
  foreign_table: string | null;
  foreign_columns: string[] | null;
}

export async function introspectSchema(readOnlyPool: pg.Pool): Promise<TableInfo[]> {
  const [columnResult, constraintResult] = await Promise.all([
    readOnlyPool.query<ColumnRow>(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `),
    readOnlyPool.query<ConstraintRow>(`
      SELECT rel.relname AS table_name,
             con.contype,
             ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS columns,
             frel.relname AS foreign_table,
             ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS foreign_columns
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
      LEFT JOIN pg_catalog.pg_class frel ON frel.oid = con.confrelid
      WHERE n.nspname = 'public' AND con.contype IN ('p', 'f')
    `),
  ]);

  const columnsByTable = groupColumns(columnResult.rows);
  const visible = (table: string, columns: readonly string[]): boolean => {
    const tableColumns = columnsByTable.get(table);
    return tableColumns !== undefined && columns.every((c) => tableColumns.some((col) => col.name === c));
  };

  return [...columnsByTable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, columns]) => {
      const constraints = constraintResult.rows.filter((row) => row.table_name === name);
      const primaryKey = constraints.find((row) => row.contype === 'p')?.columns ?? [];

      return {
        name,
        columns,
        primaryKey: visible(name, primaryKey) ? primaryKey : [],
        foreignKeys: constraints
          .filter((row) => row.contype === 'f' && row.foreign_table !== null)
          .map((row) => ({
            columns: row.columns,
            foreignTable: row.foreign_table as string,
            foreignColumns: row.foreign_columns ?? [],
          }))
          .filter((fk) => visible(name, fk.columns) && visible(fk.foreignTable, fk.foreignColumns)),
      };
    });
}

function groupColumns(rows: readonly ColumnRow[]): Map<string, ColumnInfo[]> {
  const byTable = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    const columns = byTable.get(row.table_name) ?? [];
    columns.push({ name: row.column_name, dataType: row.data_type, nullable: row.is_nullable === 'YES' });
    byTable.set(row.table_name, columns);
  }
  return byTable;
}

/** Compact text form of a table, used for the description prompt and the describeTable tool. */
export function formatTableStructure(table: TableInfo): string {
  const lines = table.columns.map((column) => {
    const notes: string[] = [];
    if (table.primaryKey.includes(column.name)) notes.push('PK');
    for (const fk of table.foreignKeys) {
      const index = fk.columns.indexOf(column.name);
      if (index >= 0) notes.push(`FK -> ${fk.foreignTable}.${fk.foreignColumns[index]}`);
    }
    const nullability = column.nullable ? '' : ' NOT NULL';
    const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
    return `  - ${column.name} ${column.dataType}${nullability}${suffix}`;
  });
  return `Table: ${table.name}\nColumns:\n${lines.join('\n')}`;
}
