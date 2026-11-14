/**
 * Builds or refreshes the schema index:
 *   npm run index-schema
 */
import { loadConfig, schemaSource } from '../config.js';
import { createMetaPool, createReadOnlyPool } from '../db/pool.js';
import { runStartupChecks } from '../db/startupCheck.js';
import { StartupError } from '../errors.js';
import { createClaudeClient } from '../llm/client.js';
import { createEmbedder } from '../schema/embeddings.js';
import { indexSchema } from '../schema/indexer.js';
import { ensureSchemaStore } from '../schema/store.js';

const config = loadConfig();
const readOnlyPool = createReadOnlyPool(config);
const metaPool = createMetaPool(config);

try {
  await runStartupChecks(config, readOnlyPool, metaPool);
  await ensureSchemaStore(metaPool);
  const startedAt = performance.now();
  const report = await indexSchema({
    readOnlyPool,
    metaPool,
    claude: createClaudeClient(config),
    model: config.ASKDB_MODEL,
    embedder: createEmbedder(config),
    source: schemaSource(config),
  });
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

  console.log(`Indexed:   ${report.indexed.join(', ') || 'none'}`);
  console.log(`Unchanged: ${report.unchanged.join(', ') || 'none'}`);
  console.log(`Removed:   ${report.removed.join(', ') || 'none'}`);
  console.log(`Database: ${schemaSource(config)}`);
  console.log(`Done in ${seconds}s (model: ${config.ASKDB_MODEL}, embeddings: ${config.ASKDB_EMBEDDINGS})`);
} catch (err) {
  if (!(err instanceof StartupError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await Promise.all([readOnlyPool.end(), metaPool.end()]);
}
