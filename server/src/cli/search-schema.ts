/**
 * Shows which tables the schema search finds for a question:
 *   npm run search-schema "which products sell the most?"
 */
import { loadConfig, schemaSource } from '../config.js';
import { createMetaPool } from '../db/pool.js';
import { createEmbedder } from '../schema/embeddings.js';
import { searchSchema } from '../schema/search.js';

const question = process.argv.slice(2).join(' ');
if (!question) {
  console.error('Usage: npm run search-schema "your question"');
  process.exit(1);
}

const config = loadConfig();
const metaPool = createMetaPool(config);
try {
  const matches = await searchSchema(metaPool, createEmbedder(config), schemaSource(config), question);
  console.table(matches.map((m) => ({ table: m.tableName, similarity: m.similarity })));
  for (const match of matches.slice(0, 3)) {
    console.log(`\n${match.tableName}: ${match.description}`);
  }
} finally {
  await metaPool.end();
}
