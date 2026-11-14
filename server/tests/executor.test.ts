/**
 * Integration tests against the real Podman database (`podman compose up -d`).
 * They skip automatically when no database credentials are available.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { SafeExecutor, loadAllowedTables } from '../src/db/executor.js';
import { validateSql, type ValidatedQuery } from '../src/db/guard.js';
import { createReadOnlyPool } from '../src/db/pool.js';
import { QueryFailedError, type QueryFailureCode } from '../src/errors.js';

const hasDatabase = Boolean(process.env.ASKDB_READONLY_PASSWORD);

/**
 * Skips the guard on purpose, to prove Layers 1 and 2 stop dangerous SQL on
 * their own. Production code can only get a ValidatedQuery from validateSql().
 */
function bypassGuard(sql: string): ValidatedQuery {
  return { sql, tables: [] } as unknown as ValidatedQuery;
}

async function failureCode(run: Promise<unknown>): Promise<QueryFailureCode | 'SUCCEEDED'> {
  try {
    await run;
    return 'SUCCEEDED';
  } catch (err) {
    if (err instanceof QueryFailedError) return err.code;
    throw err;
  }
}

describe.skipIf(!hasDatabase)('Safe executor (Layer 2) against PostgreSQL', () => {
  let pool: pg.Pool;
  let executor: SafeExecutor;
  let allowedTables: Set<string>;

  beforeAll(async () => {
    pool = createReadOnlyPool(loadConfig());
    executor = new SafeExecutor(pool, { timeoutMs: 2_000, maxRows: 500 });
    allowedTables = await loadAllowedTables(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('loads the allow-list from real database permissions', () => {
    expect(allowedTables).toContain('orders');
    expect(allowedTables).toContain('employees'); // column-level grant still counts
    expect(allowedTables.size).toBe(14);
  });

  it('runs an approved query and returns columns and rows', async () => {
    const query = validateSql('SELECT category_id, category_name FROM categories ORDER BY category_id', {
      allowedTables,
    });
    const result = await executor.run(query);

    expect(result.columns).toEqual(['category_id', 'category_name']);
    expect(result.rowCount).toBe(8);
    expect(result.rows[0]).toEqual([1, 'Beverages']);
    expect(result.truncated).toBe(false);
  });

  it('keeps duplicate column names', async () => {
    const query = validateSql(
      'SELECT o.order_id, od.order_id FROM orders o JOIN order_details od ON od.order_id = o.order_id LIMIT 1',
      { allowedTables },
    );
    const result = await executor.run(query);
    expect(result.columns).toEqual(['order_id', 'order_id']);
  });

  it('caps the number of rows and reports truncation', async () => {
    const smallExecutor = new SafeExecutor(pool, { timeoutMs: 2_000, maxRows: 5 });
    const result = await smallExecutor.run(validateSql('SELECT * FROM orders', { allowedTables }));

    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('cancels queries that run longer than the timeout', async () => {
    const fastExecutor = new SafeExecutor(pool, { timeoutMs: 300, maxRows: 5 });
    const slowQuery = validateSql('SELECT count(*) FROM generate_series(1, 500000000)', { allowedTables });

    expect(await failureCode(fastExecutor.run(slowQuery))).toBe('TIMEOUT');
  });

  it('reports ordinary SQL mistakes so they can be corrected', async () => {
    const query = validateSql('SELECT no_such_column FROM orders', { allowedTables });
    expect(await failureCode(executor.run(query))).toBe('SQL_ERROR');
  });

  describe('defence in depth: blocks dangerous SQL even if the guard is bypassed', () => {
    // Writes fail with SQL_ERROR, before read-only mode is even reached: the
    // executor wraps every query as `SELECT * FROM (<sql>) LIMIT n`, and a
    // DELETE/DROP (or a DELETE inside WITH) is not valid inside that wrapper.
    // The read-only role and transaction are proved separately by
    // scripts/verify-db-security.sh.
    it.each<[string, string, QueryFailureCode]>([
      ['DELETE', 'DELETE FROM orders', 'SQL_ERROR'],
      ['DROP TABLE', 'DROP TABLE orders', 'SQL_ERROR'],
      ['DELETE hidden in a CTE', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM d', 'SQL_ERROR'],
      ['sensitive employee column', 'SELECT home_phone FROM employees', 'PERMISSION_DENIED'],
      ['set_config', "SELECT set_config('statement_timeout', '0', false)", 'PERMISSION_DENIED'],
      ['pg_sleep', 'SELECT pg_sleep(1)', 'PERMISSION_DENIED'],
      ['read server file', "SELECT pg_read_file('/etc/passwd')", 'PERMISSION_DENIED'],
    ])('%s', async (_label, sql, expectedCode) => {
      expect(await failureCode(executor.run(bypassGuard(sql)))).toBe(expectedCode);
    });

    it('data is unchanged afterwards', async () => {
      const result = await executor.run(validateSql('SELECT count(*) AS n FROM orders', { allowedTables }));
      expect(Number(result.rows[0]?.[0])).toBe(830);
    });
  });

  it('returns connections to the pool after failures', async () => {
    // More failures than the pool has connections (3): a leak would hang here.
    for (let attempt = 0; attempt < 6; attempt++) {
      await failureCode(executor.run(bypassGuard('DELETE FROM orders')));
    }
    const result = await executor.run(validateSql('SELECT 1 AS ok', { allowedTables }));
    expect(result.rows).toEqual([[1]]);
  });
});
