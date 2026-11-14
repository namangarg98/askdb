import type pg from 'pg';
import { schemaSource, type Config } from '../config.js';
import { DatabaseConnectionError } from '../errors.js';
import { assertSafeDatabaseRole } from './roleCheck.js';

/** Which connection failed, and where its settings live, for an actionable message. */
export interface ConnectionTarget {
  /** e.g. "the database AskDB answers questions about (127.0.0.1:5434/dvdrental)" */
  readonly description: string;
  readonly user: string;
  readonly settingsFile: string;
  readonly passwordSetting: string;
  /** Extra advice when the server cannot be reached at all. */
  readonly unreachableHint: string;
  /** What to do when the login user does not exist. */
  readonly missingUserHint: string;
}

const TLS_ERROR = /SSL|TLS|certificate|CERT_|self[- ]signed/i;

/**
 * Runs before AskDB answers anything: both databases must be reachable, and the
 * queried database's role must be read-only. Any failure stops startup with a
 * message that says what to fix, instead of a stack trace.
 */
export async function runStartupChecks(config: Config, readOnlyPool: pg.Pool, metaPool: pg.Pool): Promise<void> {
  const settingsFile = config.ASKDB_DB ? `.env.${config.ASKDB_DB}` : '.env';
  await assertCanConnect(readOnlyPool, {
    description: `the database AskDB answers questions about (${schemaSource(config)})`,
    user: config.DB_READONLY_USER,
    settingsFile,
    passwordSetting: 'ASKDB_READONLY_PASSWORD',
    unreachableHint: `Is that PostgreSQL server running? Check DB_HOST and DB_PORT in ${settingsFile}.`,
    missingUserHint: 'Create it on that database with scripts/create-readonly-role.sql, or fix DB_READONLY_USER.',
  });
  const metaHost = config.META_DB_HOST ?? config.DB_HOST;
  const metaPort = config.META_DB_PORT ?? config.DB_PORT;
  await assertCanConnect(metaPool, {
    description: `AskDB's own database (${metaHost}:${metaPort}/${config.DB_META_NAME})`,
    user: config.DB_APP_USER,
    settingsFile: '.env',
    passwordSetting: 'ASKDB_APP_PASSWORD',
    unreachableHint:
      'Is the bundled container running (podman compose up -d)? ' +
      'When using your own database, set META_DB_HOST=127.0.0.1 and META_DB_PORT=5433 in its settings file.',
    missingUserHint: 'It is created by the bundled container on first start (podman compose up -d).',
  });
  await assertSafeDatabaseRole(readOnlyPool);
}

async function assertCanConnect(pool: pg.Pool, target: ConnectionTarget): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new DatabaseConnectionError(explainConnectionError(err, target));
  }
}

/**
 * Turns a connection failure into one sentence plus what to check. Only error codes
 * and PostgreSQL's own messages are used, never configuration values that may be secret.
 */
export function explainConnectionError(err: unknown, target: ConnectionTarget): string {
  const { code, message } = errorParts(err);
  const prefix = `Cannot connect to ${target.description} as "${target.user}"`;
  const exportedHint =
    target.settingsFile === '.env'
      ? ' Settings exported in this terminal override .env: open a new terminal, or use --db <name>.'
      : '';

  switch (code) {
    case '28P01':
      // PostgreSQL gives the same answer for an unknown user, so usernames cannot be probed.
      return `${prefix}: wrong password, or no such user.\nCheck ${target.passwordSetting} and the user name in ${target.settingsFile}.${exportedHint}`;
    case '28000':
      return /does not exist/i.test(message)
        ? `${prefix}: that user does not exist on this server.\n${target.missingUserHint}`
        : `${prefix}: the server refused this login (${message}).\nCheck the server's pg_hba.conf allows it.`;
    case '3D000':
      return `${prefix}: ${message}.\nCheck the database name in ${target.settingsFile}.`;
    case '53300':
      return `${prefix}: the server has no free connections for this user (${message}).\nIs another AskDB already running?`;
    case 'ECONNREFUSED':
      return `${prefix}: nothing is accepting connections at that address.\n${target.unreachableHint}`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${prefix}: the host name could not be found.\n${target.unreachableHint}`;
    case 'ETIMEDOUT':
      return `${prefix}: no response.\n${target.unreachableHint}`;
  }
  if (/timeout/i.test(message)) return `${prefix}: no response within 5 seconds.\n${target.unreachableHint}`;
  if (TLS_ERROR.test(message) || TLS_ERROR.test(code)) {
    return `${prefix}: TLS problem (${message}).\nCheck DB_SSL in ${target.settingsFile} ("verify" needs a certificate this machine trusts).`;
  }
  return `${prefix}: ${message || code || 'unknown error'}.`;
}

function errorParts(err: unknown): { code: string; message: string } {
  if (typeof err !== 'object' || err === null) return { code: '', message: String(err) };
  const record = err as { code?: unknown; message?: unknown; errors?: unknown };
  // Node reports a refused localhost connection as an AggregateError (IPv4 + IPv6 attempts).
  if (!record.code && Array.isArray(record.errors) && record.errors.length > 0) return errorParts(record.errors[0]);
  return {
    code: typeof record.code === 'string' ? record.code : '',
    message: typeof record.message === 'string' ? record.message : '',
  };
}
