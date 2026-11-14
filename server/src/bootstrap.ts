/** Wiring shared by the HTTP server and the CLI. */
import type pg from 'pg';
import { AskDbAgent } from './agent/agent.js';
import { schemaSource, type Config } from './config.js';
import { SafeExecutor, loadAllowedTables } from './db/executor.js';
import { runStartupChecks } from './db/startupCheck.js';
import { createClaudeClient } from './llm/client.js';
import { createEmbedder } from './schema/embeddings.js';

export async function buildAgent(config: Config, readOnlyPool: pg.Pool, metaPool: pg.Pool): Promise<AskDbAgent> {
  // Fails closed: both databases must be reachable, and the role must not be able to write or read hidden columns.
  await runStartupChecks(config, readOnlyPool, metaPool);
  return new AskDbAgent({
    claude: createClaudeClient(config),
    model: config.ASKDB_MODEL,
    metaPool,
    embedder: createEmbedder(config),
    schemaSource: schemaSource(config),
    executor: new SafeExecutor(readOnlyPool, { timeoutMs: config.QUERY_TIMEOUT_MS, maxRows: config.QUERY_MAX_ROWS }),
    // Read once at startup; restart the server after changing database permissions.
    allowedTables: await loadAllowedTables(readOnlyPool),
    // Strict tool schemas use structured outputs, which some gateway routes block.
    strictTools: config.ASKDB_ANTHROPIC_BASE_URL === undefined,
  });
}
