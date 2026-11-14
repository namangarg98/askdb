/**
 * Builds the schema index for one queried database ("source") in askdb_meta.schema_docs:
 *   introspect (as read-only role) -> describe (Claude) -> embed (local) -> store (pgvector)
 *
 * Re-running is cheap: tables whose structure has not changed are skipped,
 * and tables the read-only role can no longer see are removed, so search
 * never suggests a table the guard would reject.
 */
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { describeTable } from './describe.js';
import { toVectorLiteral, type Embedder } from './embeddings.js';
import { formatTableStructure, introspectSchema } from './introspect.js';

export interface IndexDependencies {
  readonly readOnlyPool: pg.Pool;
  readonly metaPool: pg.Pool;
  readonly claude: Anthropic;
  readonly model: string;
  readonly embedder: Embedder;
  /** Which queried database this index describes (see schemaSource in config.ts). */
  readonly source: string;
}

export interface IndexReport {
  readonly indexed: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

export async function indexSchema(deps: IndexDependencies): Promise<IndexReport> {
  const tables = await introspectSchema(deps.readOnlyPool);
  const existing = await deps.metaPool.query<{ table_name: string; content_hash: string }>(
    'SELECT table_name, content_hash FROM schema_docs WHERE source = $1',
    [deps.source],
  );
  const existingHashes = new Map(existing.rows.map((row) => [row.table_name, row.content_hash]));

  const changed = tables
    .map((table) => {
      const structure = formatTableStructure(table);
      // Includes the embedder, so switching embedding provider re-indexes every table.
      return { name: table.name, structure, hash: sha256(`${deps.embedder.id}\n${structure}`) };
    })
    .filter((table) => existingHashes.get(table.name) !== table.hash);

  const unchanged = tables.map((t) => t.name).filter((name) => !changed.some((c) => c.name === name));

  // Describe one table at a time to stay well inside rate limits.
  const described: { name: string; structure: string; hash: string; description: string }[] = [];
  for (const table of changed) {
    const description = await describeTable(deps.claude, deps.model, table.name, table.structure);
    described.push({ ...table, description });
  }

  const vectors = await deps.embedder.embed(
    described.map((t) => embeddingText(t.name, t.description, t.structure)),
  );

  for (const [index, table] of described.entries()) {
    await deps.metaPool.query(
      `INSERT INTO schema_docs (source, table_name, structure, description, embedding, content_hash, indexed_at)
       VALUES ($6, $1, $2, $3, $4::vector, $5, now())
       ON CONFLICT (source, table_name) DO UPDATE
         SET structure = EXCLUDED.structure, description = EXCLUDED.description,
             embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash, indexed_at = now()`,
      [table.name, table.structure, table.description, toVectorLiteral(vectors[index] ?? []), table.hash, deps.source],
    );
  }

  const currentNames = tables.map((table) => table.name);
  const removed = await deps.metaPool.query<{ table_name: string }>(
    'DELETE FROM schema_docs WHERE source = $2 AND NOT (table_name = ANY($1::text[])) RETURNING table_name',
    [currentNames, deps.source],
  );

  return {
    indexed: described.map((t) => t.name),
    unchanged,
    removed: removed.rows.map((row) => row.table_name),
  };
}

/** What gets embedded: the name, the business description, and the column names. */
function embeddingText(name: string, description: string, structure: string): string {
  const columns = [...structure.matchAll(/^\s+- (\S+)/gm)].map((match) => match[1]).join(', ');
  return `${name}: ${description} Columns: ${columns}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
