import pg from 'pg';
import type { Config } from '../config.js';

// Return dates and timestamps exactly as PostgreSQL sends them ('1997-12-01').
// By default pg builds a JS Date at LOCAL midnight, which then serialises in
// UTC: in a UTC+5:30 timezone, 1997-12-01 became "1997-11-30" in answers.
const PG_DATE = 1082;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;
for (const typeId of [PG_DATE, PG_TIMESTAMP, PG_TIMESTAMPTZ]) {
  pg.types.setTypeParser(typeId, (value: string) => value);
}

/**
 * Connection pool for the queried database, always as the locked-down read-only
 * role (Layer 1). The pool size stays below the role's CONNECTION LIMIT of 5.
 */
export function createReadOnlyPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_READONLY_USER,
    password: config.ASKDB_READONLY_PASSWORD,
    ssl: sslOptions(config.DB_SSL),
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Client-side backstop in case the server-side statement_timeout never fires.
    query_timeout: config.QUERY_TIMEOUT_MS + 2_000,
    application_name: 'askdb',
  });
  return withIdleErrorLogging(pool, 'readonly');
}

/**
 * Pool for AskDB's own database (`askdb_meta`) as `askdb_app`. This role
 * cannot connect to the data being queried, and the read-only role cannot
 * connect here.
 */
export function createMetaPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    host: config.META_DB_HOST ?? config.DB_HOST,
    port: config.META_DB_PORT ?? config.DB_PORT,
    database: config.DB_META_NAME,
    user: config.DB_APP_USER,
    password: config.ASKDB_APP_PASSWORD,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'askdb-meta',
  });

  return withIdleErrorLogging(pool, 'meta');
}

/** "verify" checks the server certificate against the system's trusted CAs; "require" only encrypts. */
function sslOptions(mode: Config['DB_SSL']): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify' };
}

// An idle connection dropping (e.g. DB restart) must not crash the process.
function withIdleErrorLogging(pool: pg.Pool, name: string): pg.Pool {
  pool.on('error', (err) => {
    console.error('db_pool_idle_client_error pool=%s message=%s', name, err.message);
  });
  return pool;
}
