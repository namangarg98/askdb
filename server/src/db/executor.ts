/**
 * Security Layer 2: safe execution.
 *
 * Runs guard-approved SQL inside a READ ONLY transaction with a statement
 * timeout and a hard row cap, and always rolls back. Combined with the
 * read-only role (Layer 1), a query cannot change data even if the guard
 * (Layer 3) were bypassed.
 */
import type pg from 'pg';
import { QueryFailedError } from '../errors.js';
import type { ValidatedQuery } from './guard.js';

export interface ExecutorOptions {
  readonly timeoutMs: number;
  readonly maxRows: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  /** Rows as arrays, so duplicate column names (e.g. two "id" columns) are kept. */
  readonly rows: readonly unknown[][];
  readonly rowCount: number;
  /** True when the query returned more than `maxRows` and the result was cut. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** PostgreSQL error codes we translate into clear failure reasons. */
const PG_ERROR_CODES = {
  queryCanceled: '57014',
  insufficientPrivilege: '42501',
  readOnlyTransaction: '25006',
} as const;

export class SafeExecutor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: ExecutorOptions,
  ) {}

  async run(query: ValidatedQuery): Promise<QueryResult> {
    const client = await this.connect();
    const startedAt = performance.now();
    let clientBroken = false;

    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      // Both values are integers validated by the config schema, so inlining is safe.
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(this.options.timeoutMs)}`);
      await client.query(`SET LOCAL lock_timeout = 1000`);

      const queryConfig: pg.QueryArrayConfig = {
        text: wrapWithRowLimit(query.sql, this.options.maxRows),
        rowMode: 'array',
      };
      const result = await client.query(queryConfig);

      const truncated = result.rows.length > this.options.maxRows;
      const rows = truncated ? result.rows.slice(0, this.options.maxRows) : result.rows;

      return {
        columns: result.fields.map((field) => field.name),
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (err) {
      throw toQueryFailedError(err);
    } finally {
      // Nothing an AI-generated query does is ever committed.
      try {
        await client.query('ROLLBACK');
      } catch {
        clientBroken = true;
      }
      // A connection whose rollback failed is destroyed rather than reused.
      client.release(clientBroken);
    }
  }

  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (err) {
      throw new QueryFailedError('DB_UNAVAILABLE', 'Could not connect to the database.', { cause: err });
    }
  }
}

/**
 * Wraps the query so at most maxRows + 1 rows ever leave the database; the
 * extra row tells us the result was truncated. The newlines matter: they end
 * any trailing `--` comment in the user SQL before our closing parenthesis.
 */
function wrapWithRowLimit(sql: string, maxRows: number): string {
  return `SELECT * FROM (\n${sql}\n) AS askdb_result LIMIT ${Math.trunc(maxRows) + 1}`;
}

function toQueryFailedError(err: unknown): QueryFailedError {
  if (err instanceof QueryFailedError) return err;

  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case PG_ERROR_CODES.queryCanceled:
      return new QueryFailedError('TIMEOUT', 'The query took too long and was cancelled.', { cause: err });
    case PG_ERROR_CODES.insufficientPrivilege:
      return new QueryFailedError('PERMISSION_DENIED', message, { cause: err });
    case PG_ERROR_CODES.readOnlyTransaction:
      return new QueryFailedError('READ_ONLY_VIOLATION', message, { cause: err });
    default:
      if (message.includes('Query read timeout')) {
        return new QueryFailedError('TIMEOUT', 'The query took too long and was cancelled.', { cause: err });
      }
      // Regular SQL mistakes (unknown column, bad syntax): the message helps the LLM fix its query.
      return new QueryFailedError('SQL_ERROR', message, { cause: err });
  }
}

/**
 * Tables the read-only role may read (whole table or some columns). This is
 * the guard's allow-list, so it always matches the real database permissions.
 */
export async function loadAllowedTables(pool: pg.Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p')
      AND (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'))
  `);
  return new Set(result.rows.map((row) => row.table_name.toLowerCase()));
}
