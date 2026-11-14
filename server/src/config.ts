import { z } from 'zod';
import { applyDbProfile } from './dbProfile.js';

// Every entry point (server, CLI, eval) imports this module before reading its own
// arguments, so `--db <name>` is applied here once, and removed from argv.
applyDbProfile();

/**
 * All runtime settings, validated once at startup. If something is missing or
 * invalid the server refuses to start, instead of failing later mid-request.
 */
const EnvSchema = z.object({
  // The database AskDB answers questions about: the bundled Northwind demo, or your own PostgreSQL.
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(5433),
  DB_NAME: z.string().min(1).default('northwind'),
  DB_READONLY_USER: z.string().min(1).default('askdb_readonly'),
  ASKDB_READONLY_PASSWORD: z.string().min(1, 'ASKDB_READONLY_PASSWORD is required'),
  // TLS to that database: "disable" (local), "verify" (encrypted + certificate checked, use for remote
  // databases), or "require" (encrypted, certificate NOT checked; only if verify is impossible).
  DB_SSL: z.enum(['disable', 'verify', 'require']).default('disable'),
  // Set by --db <name> (or directly): the settings file .env.<name> that was loaded.
  ASKDB_DB: z.string().min(1).optional(),

  // Layer 2 limits for every AI-generated query.
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(10_000).default(500),

  // AskDB's own database (schema index, audit log), owned by askdb_app. It can live on a different
  // server from the database being queried; by default it is next to it.
  META_DB_HOST: z.string().min(1).optional(),
  META_DB_PORT: z.coerce.number().int().positive().optional(),
  DB_META_NAME: z.string().min(1).default('askdb_meta'),
  DB_APP_USER: z.string().min(1).default('askdb_app'),
  ASKDB_APP_PASSWORD: z.string().min(1, 'ASKDB_APP_PASSWORD is required'),

  // Claude.
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ASKDB_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  // Empty means api.anthropic.com; otherwise an Anthropic-compatible gateway.
  ASKDB_ANTHROPIC_BASE_URL: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined))
    .pipe(z.url().optional()),

  // Schema-search embeddings: a model run locally, or one served by the gateway.
  ASKDB_EMBEDDINGS: z.enum(['local', 'gateway']).default('local'),

  // HTTP API. Listens on localhost only unless HOST is changed deliberately.
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  // Set to true only behind a trusted reverse proxy, so client IPs are read correctly.
  TRUST_PROXY: z.stringbool().default(false),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  // Stop answering once today's estimated Claude spend reaches this (protects a public demo).
  DAILY_BUDGET_USD: z.coerce.number().min(0).max(1_000).default(1),
  // Saved result rows (for reopening history) are deleted after this many days; the audit record stays.
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Key for turning client IPs into anonymous IDs in the audit log (IPs are never stored).
  ASKDB_CLIENT_ID_SECRET: z.string().min(16, 'ASKDB_CLIENT_ID_SECRET must be at least 16 characters'),
}).refine((env) => env.ASKDB_EMBEDDINGS !== 'gateway' || env.ASKDB_ANTHROPIC_BASE_URL, {
  path: ['ASKDB_EMBEDDINGS'],
  message: '"gateway" embeddings need ASKDB_ANTHROPIC_BASE_URL to be set',
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Identifies the queried database in the schema index, so indexing a second
 * database never overwrites or deletes the first one's entries.
 */
export function schemaSource(config: Config): string {
  return `${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    // List which settings are wrong, never their values (they may be secrets).
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
