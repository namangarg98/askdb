/**
 * Starts the AskDB API:
 *   npm run dev     (restarts on code changes)
 *   npm start
 */
import { createApp } from './api/app.js';
import { AuditLog } from './audit/auditLog.js';
import { buildAgent } from './bootstrap.js';
import { loadConfig, schemaSource } from './config.js';
import { countIndexedTables, ensureSchemaStore } from './schema/store.js';
import { createMetaPool, createReadOnlyPool } from './db/pool.js';
import { StartupError } from './errors.js';

const config = loadConfig();
const readOnlyPool = createReadOnlyPool(config);
const metaPool = createMetaPool(config);

// Builds the agent first: it checks both databases are reachable and the role is read-only,
// and refuses to start otherwise.
console.log(`askdb_api_starting db=${schemaSource(config)}${config.ASKDB_DB ? ` settings=.env.${config.ASKDB_DB}` : ''}`);
const asker = await buildAgent(config, readOnlyPool, metaPool).catch(async (err: unknown) => {
  if (!(err instanceof StartupError)) throw err;
  console.error(err.message);
  await Promise.all([readOnlyPool.end(), metaPool.end()]);
  process.exit(1);
});

const audit = new AuditLog(metaPool, schemaSource(config));
await audit.ensureSchema();

// Remove saved result rows past the retention period, now and then hourly.
const HOUR_MS = 3_600_000;
const expireSnapshots = () =>
  audit.expireSnapshots(config.HISTORY_RETENTION_DAYS).catch((err: unknown) => console.error('snapshot_expiry_failed', err));
await expireSnapshots();
const expiryTimer = setInterval(() => void expireSnapshots(), HOUR_MS);
expiryTimer.unref();

await ensureSchemaStore(metaPool);
if ((await countIndexedTables(metaPool, schemaSource(config))) === 0) {
  console.warn('schema_index_empty source=%s: run `npm run index-schema` before asking questions', schemaSource(config));
}

const app = createApp({
  asker,
  audit,
  model: config.ASKDB_MODEL,
  checkHealth: async () => ({
    database: await isReachable(() => readOnlyPool.query('SELECT 1')),
    metaDatabase: await isReachable(() => metaPool.query('SELECT 1')),
  }),
  options: {
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    dailyBudgetUsd: config.DAILY_BUDGET_USD,
    trustProxy: config.TRUST_PROXY,
    clientIdSecret: config.ASKDB_CLIENT_ID_SECRET,
  },
});

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`askdb_api_listening url=http://${config.HOST}:${config.PORT} db=${schemaSource(config)} model=${config.ASKDB_MODEL}`);
});

async function isReachable(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`askdb_api_stopping signal=${signal}`);
  server.close();
  await Promise.all([readOnlyPool.end(), metaPool.end()]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
