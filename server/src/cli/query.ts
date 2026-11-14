/**
 * Try the safety pipeline by hand:
 *   npm run query "SELECT category_name FROM categories"
 *
 * SQL -> Guard (Layer 3) -> Safe executor (Layer 2) -> read-only role (Layer 1)
 */
import { loadConfig } from '../config.js';
import { QueryFailedError, SqlRejectedError } from '../errors.js';
import { SafeExecutor, loadAllowedTables } from '../db/executor.js';
import { validateSql } from '../db/guard.js';
import { createReadOnlyPool } from '../db/pool.js';

const MAX_ROWS_TO_PRINT = 20;

async function main(): Promise<void> {
  const sql = process.argv.slice(2).join(' ');
  if (!sql) {
    console.error('Usage: npm run query "SELECT ..."');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const pool = createReadOnlyPool(config);
  const executor = new SafeExecutor(pool, {
    timeoutMs: config.QUERY_TIMEOUT_MS,
    maxRows: config.QUERY_MAX_ROWS,
  });

  try {
    const allowedTables = await loadAllowedTables(pool);
    const query = validateSql(sql, { allowedTables });
    console.log(`Guard: approved (tables: ${query.tables.join(', ') || 'none'})`);

    const result = await executor.run(query);
    console.table(result.rows.slice(0, MAX_ROWS_TO_PRINT).map((row) => toObject(result.columns, row)));
    console.log(
      `${result.rowCount} row(s) in ${result.durationMs} ms${result.truncated ? ' (truncated)' : ''}`,
    );
  } catch (err) {
    if (err instanceof SqlRejectedError) {
      console.error(`Rejected by SQL Guard [${err.code}]: ${err.message}`);
    } else if (err instanceof QueryFailedError) {
      console.error(`Stopped by database [${err.code}]: ${err.message}`);
    } else {
      throw err;
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** For display only: give duplicate column names a suffix so none are hidden. */
function toObject(columns: readonly string[], row: readonly unknown[]): Record<string, unknown> {
  const seen = new Map<string, number>();
  const entry: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    const count = (seen.get(column) ?? 0) + 1;
    seen.set(column, count);
    entry[count === 1 ? column : `${column}_${count}`] = row[index];
  });
  return entry;
}

await main();
