import type pg from 'pg';
import { toVectorLiteral, type Embedder } from './embeddings.js';

export interface SchemaMatch {
  readonly tableName: string;
  readonly description: string;
  /** Cosine similarity between the question and the table description, 0-1. */
  readonly similarity: number;
}

/** Finds the tables most related to a plain-English question (pgvector cosine distance). */
export async function searchSchema(
  metaPool: pg.Pool,
  embedder: Embedder,
  source: string,
  question: string,
  limit = 5,
): Promise<SchemaMatch[]> {
  const [vector] = await embedder.embed([question]);
  if (!vector) return [];

  const result = await metaPool.query<{ table_name: string; description: string; similarity: number }>(
    `SELECT table_name, description, 1 - (embedding <=> $1::vector) AS similarity
     FROM schema_docs
     WHERE source = $3
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(vector), limit, source],
  );

  return result.rows.map((row) => ({
    tableName: row.table_name,
    description: row.description,
    similarity: Math.round(Number(row.similarity) * 1000) / 1000,
  }));
}

/** The stored structure of one table (only columns the read-only role can see). */
export async function findTableStructure(metaPool: pg.Pool, source: string, tableName: string): Promise<string | undefined> {
  const result = await metaPool.query<{ structure: string }>(
    'SELECT structure FROM schema_docs WHERE source = $1 AND table_name = $2',
    [source, tableName.toLowerCase()],
  );
  return result.rows[0]?.structure;
}
