/**
 * Integration tests for schema introspection and search (needs the Podman DB).
 * No Claude calls: search tests use whatever `npm run index-schema` stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig, schemaSource } from '../src/config.js';
import { createMetaPool, createReadOnlyPool } from '../src/db/pool.js';
import { createEmbedder } from '../src/schema/embeddings.js';
import { formatTableStructure, introspectSchema, type TableInfo } from '../src/schema/introspect.js';
import { searchSchema } from '../src/schema/search.js';
import { ensureSchemaStore } from '../src/schema/store.js';

const hasDatabase = Boolean(process.env.ASKDB_READONLY_PASSWORD && process.env.ASKDB_APP_PASSWORD);

describe.skipIf(!hasDatabase)('Schema introspection (as the read-only role)', () => {
  let readOnlyPool: pg.Pool;
  let tables: TableInfo[];

  beforeAll(async () => {
    readOnlyPool = createReadOnlyPool(loadConfig());
    tables = await introspectSchema(readOnlyPool);
  });

  afterAll(async () => {
    await readOnlyPool?.end();
  });

  const table = (name: string): TableInfo => {
    const found = tables.find((t) => t.name === name);
    if (!found) throw new Error(`table ${name} not found`);
    return found;
  };

  it('finds all 14 tables', () => {
    expect(tables).toHaveLength(14);
  });

  it('never exposes columns hidden from the read-only role (privacy, Layer 4)', () => {
    const employeeColumns = table('employees').columns.map((c) => c.name);
    expect(employeeColumns).toContain('first_name');
    for (const hidden of ['birth_date', 'address', 'home_phone', 'notes', 'photo']) {
      expect(employeeColumns).not.toContain(hidden);
      expect(formatTableStructure(table('employees'))).not.toContain(hidden);
    }
  });

  it('includes primary and foreign keys so Claude can write joins', () => {
    const orderDetails = table('order_details');
    expect(orderDetails.primaryKey).toEqual(['order_id', 'product_id']);
    expect(orderDetails.foreignKeys).toContainEqual({
      columns: ['product_id'],
      foreignTable: 'products',
      foreignColumns: ['product_id'],
    });
    expect(formatTableStructure(orderDetails)).toContain('product_id smallint NOT NULL (PK, FK -> products.product_id)');
  });
});

describe.skipIf(!hasDatabase)('Schema search (pgvector)', () => {
  let metaPool: pg.Pool;
  let indexed = false;

  beforeAll(async () => {
    metaPool = createMetaPool(loadConfig());
    // On a fresh database (e.g. CI) the index table does not exist yet; the server creates it at startup.
    await ensureSchemaStore(metaPool);
    const result = await metaPool.query<{ n: string }>('SELECT count(*) AS n FROM schema_docs WHERE source = $1', [schemaSource(loadConfig())]);
    indexed = Number(result.rows[0]?.n) > 0;
  });

  afterAll(async () => {
    await metaPool?.end();
  });

  it('keeps each database\'s index separate', async () => {
    if (!indexed) return;
    const config = loadConfig();
    const otherDatabase = await searchSchema(metaPool, createEmbedder(config), 'elsewhere:5432/other_db', 'orders', 4);
    expect(otherDatabase).toEqual([]);
  }, 60_000);

  it.each([
    ['which products bring in the most revenue?', ['order_details', 'products']],
    ['which shipping company delivers the most orders?', ['shippers']],
    ['who are our customers in Germany?', ['customers']],
  ])('"%s" finds the right tables', async (question, expectedTables) => {
    if (!indexed) return; // run `npm run index-schema` first
    const config = loadConfig();
    const top = (await searchSchema(metaPool, createEmbedder(config), schemaSource(config), question, 4)).map((m) => m.tableName);
    for (const expected of expectedTables) expect(top).toContain(expected);
  }, 60_000);
});
