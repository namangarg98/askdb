/**
 * Integration tests for the startup role check, against the real Podman database.
 * They create a deliberately over-privileged role, and drop it again afterwards.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertSafeDatabaseRole, findRoleProblems } from '../src/db/roleCheck.js';
import { createReadOnlyPool } from '../src/db/pool.js';
import { UnsafeDatabaseRoleError } from '../src/errors.js';

const hasDatabase = Boolean(process.env.ASKDB_READONLY_PASSWORD && process.env.POSTGRES_PASSWORD);
const UNSAFE_ROLE = 'askdb_test_unsafe';

describe.skipIf(!hasDatabase)('Startup role check against PostgreSQL', () => {
  const config = hasDatabase ? loadConfig() : undefined;
  const unsafePassword = randomBytes(16).toString('hex');
  let admin: pg.Pool;
  let readOnly: pg.Pool;
  let unsafe: pg.Pool;

  const connect = (user: string, password: string) =>
    new pg.Pool({ host: config?.DB_HOST, port: config?.DB_PORT, database: config?.DB_NAME, user, password, max: 1 });

  beforeAll(async () => {
    admin = connect(process.env.POSTGRES_USER ?? 'postgres', process.env.POSTGRES_PASSWORD ?? '');
    readOnly = createReadOnlyPool(loadConfig());
    await admin.query(`DROP OWNED BY ${UNSAFE_ROLE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${UNSAFE_ROLE}`);
    await admin.query(`CREATE ROLE ${UNSAFE_ROLE} LOGIN PASSWORD '${unsafePassword}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${config?.DB_NAME} TO ${UNSAFE_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${UNSAFE_ROLE}`);
    await admin.query(`GRANT SELECT, INSERT ON public.shippers TO ${UNSAFE_ROLE}`);
    await admin.query(`GRANT pg_read_all_data TO ${UNSAFE_ROLE}`);
    unsafe = connect(UNSAFE_ROLE, unsafePassword);
  });

  afterAll(async () => {
    await unsafe?.end();
    await readOnly?.end();
    await admin?.query(`DROP OWNED BY ${UNSAFE_ROLE}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${UNSAFE_ROLE}`);
    await admin?.end();
  });

  it('accepts the restricted read-only role', async () => {
    expect(await findRoleProblems(readOnly)).toEqual([]);
    await expect(assertSafeDatabaseRole(readOnly)).resolves.toBeUndefined();
  });

  it('refuses a superuser', async () => {
    expect(await findRoleProblems(admin)).toEqual([expect.stringMatching(/is a superuser/)]);
  });

  it('refuses a role that can write a table or read hidden columns', async () => {
    const problems = await findRoleProblems(unsafe);
    expect(problems).toContainEqual(expect.stringMatching(/member of pg_read_all_data/));
    expect(problems).toContainEqual(expect.stringMatching(/can change 1 table\(s\): public\.shippers \(INSERT\)/));
    await expect(assertSafeDatabaseRole(unsafe)).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });
});
