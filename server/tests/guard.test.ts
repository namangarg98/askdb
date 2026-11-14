import { describe, expect, it } from 'vitest';
import { validateSql } from '../src/db/guard.js';
import { SqlRejectedError, type SqlRejectionCode } from '../src/errors.js';

const allowedTables = new Set([
  'orders', 'order_details', 'products', 'categories', 'customers', 'employees', 'shippers',
]);

function rejectionCode(sql: string): SqlRejectionCode | 'ACCEPTED' {
  try {
    validateSql(sql, { allowedTables });
    return 'ACCEPTED';
  } catch (err) {
    if (err instanceof SqlRejectedError) return err.code;
    throw err;
  }
}

describe('SQL Guard: accepts normal analytical queries', () => {
  it.each([
    ['simple select', 'SELECT category_name FROM categories'],
    ['trailing semicolon', 'SELECT * FROM orders;'],
    ['join + filter', `SELECT o.order_id, c.company_name FROM orders o
       JOIN customers c ON c.customer_id = o.customer_id WHERE o.ship_country = 'Germany'`],
    ['aggregate + group by + order by + limit', `SELECT p.product_name,
       SUM(od.unit_price * od.quantity * (1 - od.discount)) AS revenue
       FROM order_details od JOIN products p ON p.product_id = od.product_id
       GROUP BY p.product_name ORDER BY revenue DESC LIMIT 5`],
    ['CTE', 'WITH recent AS (SELECT * FROM orders WHERE order_date > \'1998-01-01\') SELECT count(*) FROM recent'],
    ['subquery', 'SELECT * FROM products WHERE category_id IN (SELECT category_id FROM categories)'],
    ['window function + date_trunc', `SELECT date_trunc('month', order_date) AS month,
       count(*) OVER (PARTITION BY ship_country) FROM orders`],
    ['union', 'SELECT city FROM customers UNION SELECT city FROM employees'],
    ['trailing line comment', 'SELECT * FROM orders -- latest orders'],
  ])('%s', (_label, sql) => {
    expect(rejectionCode(sql)).toBe('ACCEPTED');
  });

  it('returns the cleaned SQL and the tables it reads', () => {
    const result = validateSql('  SELECT * FROM orders o JOIN customers c ON true;  ', { allowedTables });
    expect(result.sql).toBe('SELECT * FROM orders o JOIN customers c ON true');
    expect(result.tables).toEqual(['customers', 'orders']);
  });
});

describe('SQL Guard: blocks attacks and unsafe queries', () => {
  it.each<[string, string, SqlRejectionCode]>([
    // Writes and schema changes
    ['DELETE', 'DELETE FROM orders', 'NOT_SELECT'],
    ['UPDATE', 'UPDATE products SET unit_price = 0', 'NOT_SELECT'],
    ['INSERT', "INSERT INTO shippers VALUES (99, 'x', 'y')", 'NOT_SELECT'],
    ['DROP', 'DROP TABLE orders', 'NOT_SELECT'],
    ['TRUNCATE', 'TRUNCATE orders', 'NOT_SELECT'],
    ['ALTER', 'ALTER TABLE orders ADD COLUMN x int', 'NOT_SELECT'],
    ['GRANT', 'GRANT ALL ON orders TO public', 'NOT_SELECT'],
    ['SET (switch off limits)', 'SET statement_timeout = 0', 'NOT_SELECT'],

    // Smuggling a second statement or a write inside a SELECT
    ['stacked statements', 'SELECT 1; DROP TABLE orders', 'MULTIPLE_STATEMENTS'],
    ['stacked after comment trick', 'SELECT 1; -- harmless\nDELETE FROM orders', 'MULTIPLE_STATEMENTS'],
    ['DELETE hidden in a CTE', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', 'PARSE_ERROR'],
    ['SELECT INTO creates a table', 'SELECT * INTO stolen FROM orders', 'SELECT_INTO'],
    ['FOR UPDATE row locks', 'SELECT * FROM orders FOR UPDATE', 'PARSE_ERROR'],

    // Dangerous functions
    ['pg_sleep stall', 'SELECT pg_sleep(10)', 'FORBIDDEN_FUNCTION'],
    ['schema-qualified pg_sleep', 'SELECT pg_catalog.pg_sleep(10)', 'FORBIDDEN_FUNCTION'],
    ['set_config lifts limits', "SELECT set_config('statement_timeout', '0', false)", 'FORBIDDEN_FUNCTION'],
    ['read server files', "SELECT pg_read_file('/etc/passwd')", 'FORBIDDEN_FUNCTION'],
    ['run SQL from a string', "SELECT query_to_xml('DELETE FROM orders', true, false, '')", 'FORBIDDEN_FUNCTION'],
    ['function hidden in a WHERE', 'SELECT * FROM orders WHERE pg_sleep(1) IS NULL', 'FORBIDDEN_FUNCTION'],
    ['advance a sequence', "SELECT nextval('orders_seq')", 'FORBIDDEN_FUNCTION'],

    // Tables outside the allow-list
    ['system catalog', 'SELECT * FROM pg_catalog.pg_roles', 'TABLE_NOT_ALLOWED'],
    ['unqualified system view', 'SELECT * FROM pg_roles', 'TABLE_NOT_ALLOWED'],
    ['information_schema', 'SELECT * FROM information_schema.tables', 'TABLE_NOT_ALLOWED'],
    ['table not on the allow-list', 'SELECT * FROM suppliers', 'TABLE_NOT_ALLOWED'],
    ['allowed table, other schema', 'SELECT * FROM other.orders', 'TABLE_NOT_ALLOWED'],
    ['forbidden table in a subquery', 'SELECT * FROM orders WHERE 1 = (SELECT 1 FROM pg_shadow)', 'TABLE_NOT_ALLOWED'],

    // Malformed input
    ['empty', '   ', 'EMPTY'],
    ['only a semicolon', ';', 'EMPTY'],
    ['not SQL', 'show me the top customers', 'PARSE_ERROR'],
  ])('%s', (_label, sql, expectedCode) => {
    expect(rejectionCode(sql)).toBe(expectedCode);
  });

  it('rejects queries over the length limit', () => {
    const longSql = `SELECT ${'1 + '.repeat(2_000)}1`;
    expect(() => validateSql(longSql, { allowedTables })).toThrow(SqlRejectedError);
    expect(rejectionCode(longSql)).toBe('TOO_LONG');
  });
});
