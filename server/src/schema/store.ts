/**
 * The schema index table in AskDB's own database (askdb_meta.schema_docs).
 *
 * Each row describes one table of one queried database ("source", e.g.
 * 127.0.0.1:5433/northwind), so several databases can share one AskDB
 * database without overwriting each other. Created here rather than in a
 * container init script, so any PostgreSQL with pgvector can host it.
 */
import type pg from 'pg';
import { EMBEDDING_DIMENSIONS } from './embeddings.js';

export async function ensureSchemaStore(metaPool: pg.Pool): Promise<void> {
  // Needs to be installed by an admin once (CREATE EXTENSION vector); this only checks it.
  const extension = await metaPool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  if (extension.rowCount === 0) {
    throw new Error('The pgvector extension is not installed in the AskDB database. Run: CREATE EXTENSION vector;');
  }

  await metaPool.query(`
    CREATE TABLE IF NOT EXISTS schema_docs (
      source       text        NOT NULL,
      table_name   text        NOT NULL,
      structure    text        NOT NULL,
      description  text        NOT NULL,
      embedding    vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
      -- Hash of embedder + structure: unchanged tables are not re-described on re-index.
      content_hash text        NOT NULL,
      indexed_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, table_name)
    )
  `);

  // Upgrade from the first version, which indexed a single database and had no
  // "source" column. The index is a cache, so old rows are dropped; the next
  // `npm run index-schema` rebuilds them (a few cents of model calls at most).
  const hasSource = await metaPool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'schema_docs' AND column_name = 'source'",
  );
  if (hasSource.rowCount === 0) {
    await metaPool.query(`
      DELETE FROM schema_docs;
      ALTER TABLE schema_docs DROP CONSTRAINT IF EXISTS schema_docs_pkey;
      ALTER TABLE schema_docs ADD COLUMN source text NOT NULL;
      ALTER TABLE schema_docs ADD PRIMARY KEY (source, table_name);
    `);
    console.warn('schema_index_upgraded: entries are now kept per database; run `npm run index-schema` again');
  }
}

export async function countIndexedTables(metaPool: pg.Pool, source: string): Promise<number> {
  const result = await metaPool.query<{ n: string }>('SELECT count(*) AS n FROM schema_docs WHERE source = $1', [source]);
  return Number(result.rows[0]?.n ?? 0);
}
