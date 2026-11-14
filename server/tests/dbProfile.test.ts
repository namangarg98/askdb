import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyDbProfile } from '../src/dbProfile.js';

describe('--db profile selection', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'askdb-profile-'));
    writeFileSync(path.join(root, '.env.shop'), 'DB_NAME=shop\nDB_PORT=5434\n# a comment\nDB_SSL=verify');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads .env.<name> over existing values and removes the flag from argv', () => {
    const argv = ['node', 'ask.ts', '--db', 'shop', 'How many orders?'];
    const env: NodeJS.ProcessEnv = { DB_NAME: 'northwind', DB_HOST: '127.0.0.1' };

    expect(applyDbProfile(argv, env, root)).toBe('shop');
    expect(env).toMatchObject({ DB_NAME: 'shop', DB_PORT: '5434', DB_SSL: 'verify', DB_HOST: '127.0.0.1', ASKDB_DB: 'shop' });
    expect(argv).toEqual(['node', 'ask.ts', 'How many orders?']);
  });

  it('accepts --db=name and the ASKDB_DB variable', () => {
    const argv = ['node', 'server.ts', '--db=shop'];
    const env: NodeJS.ProcessEnv = {};
    expect(applyDbProfile(argv, env, root)).toBe('shop');
    expect(argv).toEqual(['node', 'server.ts']);

    const fromVariable: NodeJS.ProcessEnv = { ASKDB_DB: 'shop' };
    expect(applyDbProfile(['node', 'server.ts'], fromVariable, root)).toBe('shop');
    expect(fromVariable.DB_NAME).toBe('shop');
  });

  it('changes nothing when no profile is selected', () => {
    const argv = ['node', 'ask.ts', 'question'];
    const env: NodeJS.ProcessEnv = { DB_NAME: 'northwind' };
    expect(applyDbProfile(argv, env, root)).toBeUndefined();
    expect(env).toEqual({ DB_NAME: 'northwind' });
    expect(argv).toEqual(['node', 'ask.ts', 'question']);
  });

  it('rejects names that could reach other files, missing files and a missing name', () => {
    expect(() => applyDbProfile(['node', 'x', '--db', '../secrets'], {}, root)).toThrow(/Invalid --db name/);
    expect(() => applyDbProfile(['node', 'x', '--db', 'nope'], {}, root)).toThrow(/not found/);
    expect(() => applyDbProfile(['node', 'x', '--db'], {}, root)).toThrow(/needs a name/);
  });
});
