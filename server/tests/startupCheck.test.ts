import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { explainConnectionError, runStartupChecks, type ConnectionTarget } from '../src/db/startupCheck.js';
import { createMetaPool, createReadOnlyPool } from '../src/db/pool.js';
import { DatabaseConnectionError } from '../src/errors.js';

const target: ConnectionTarget = {
  description: 'the database AskDB answers questions about (127.0.0.1:5434/dvdrental)',
  user: 'askdb_readonly',
  settingsFile: '.env.dvdrental',
  passwordSetting: 'ASKDB_READONLY_PASSWORD',
  unreachableHint: 'Is that PostgreSQL server running?',
  missingUserHint: 'Create it with scripts/create-readonly-role.sql.',
};

describe('Connection error messages', () => {
  it('names the setting and file to fix for a wrong password', () => {
    const message = explainConnectionError({ code: '28P01', message: 'password authentication failed' }, target);
    expect(message).toBe(
      'Cannot connect to the database AskDB answers questions about (127.0.0.1:5434/dvdrental) as "askdb_readonly": ' +
        'wrong password, or no such user.\nCheck ASKDB_READONLY_PASSWORD and the user name in .env.dvdrental.',
    );
  });

  it('mentions exported terminal settings only when .env alone is in use', () => {
    const message = explainConnectionError({ code: '28P01', message: '' }, { ...target, settingsFile: '.env' });
    expect(message).toMatch(/Settings exported in this terminal override \.env/);
  });

  it('explains unreachable servers, missing users and databases, TLS and unknown errors', () => {
    const refused = new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })]);
    expect(explainConnectionError(refused, target)).toMatch(/nothing is accepting connections.*\nIs that PostgreSQL server running\?/);
    expect(explainConnectionError({ code: '28000', message: 'role "x" does not exist' }, target)).toMatch(/user does not exist.*\nCreate it/);
    expect(explainConnectionError({ code: '3D000', message: 'database "dvd" does not exist' }, target)).toMatch(/database "dvd" does not exist/);
    expect(explainConnectionError(new Error('timeout expired'), target)).toMatch(/no response within 5 seconds/);
    expect(explainConnectionError(new Error('self-signed certificate'), target)).toMatch(/TLS problem.*\nCheck DB_SSL/);
    expect(explainConnectionError(new Error('something odd'), target)).toMatch(/: something odd\.$/);
  });
});

const hasDatabase = Boolean(process.env.ASKDB_READONLY_PASSWORD);

describe.skipIf(!hasDatabase)('Startup checks against PostgreSQL', () => {
  const pools: pg.Pool[] = [];
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  async function startupMessage(overrides: Record<string, string>): Promise<string> {
    const config = loadConfig({ ...process.env, ...overrides });
    const readOnly = createReadOnlyPool(config);
    const meta = createMetaPool(config);
    pools.push(readOnly, meta);
    try {
      await runStartupChecks(config, readOnly, meta);
      return 'STARTED';
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseConnectionError);
      return (err as Error).message;
    }
  }

  it('passes with the correct settings', async () => {
    expect(await startupMessage({})).toBe('STARTED');
  });

  it('reports a wrong password, a closed port, a missing database and an unknown user', async () => {
    expect(await startupMessage({ ASKDB_READONLY_PASSWORD: 'not-the-password' })).toMatch(/wrong password, or no such user\.\nCheck ASKDB_READONLY_PASSWORD/);
    expect(await startupMessage({ DB_PORT: '1', META_DB_PORT: '5433' })).toMatch(/nothing is accepting connections/);
    expect(await startupMessage({ DB_NAME: 'no_such_db' })).toMatch(/database "no_such_db" does not exist/);
    expect(await startupMessage({ DB_READONLY_USER: 'no_such_user' })).toMatch(/wrong password, or no such user/);
  });

  it("reports a problem with AskDB's own database separately", async () => {
    expect(await startupMessage({ ASKDB_APP_PASSWORD: 'not-the-password' })).toMatch(
      /Cannot connect to AskDB's own database .* as "askdb_app": wrong password, or no such user\.\nCheck ASKDB_APP_PASSWORD/,
    );
  });
});
