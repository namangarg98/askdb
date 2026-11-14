import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** The askdb/ folder, where .env and the per-database files such as .env.dvdrental live. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Selects a per-database settings file, so one AskDB checkout can switch between databases:
 *   npm run dev -- --db dvdrental        (or: ASKDB_DB=dvdrental npm run dev)
 * loads ../.env.dvdrental on top of ../.env. Values from the profile file win.
 *
 * The --db flag is removed from argv, so commands that read their own arguments
 * (e.g. `npm run ask -- --db dvdrental "question"`) never see it.
 * Returns the profile name, or undefined when none was selected.
 */
export function applyDbProfile(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = PROJECT_ROOT,
): string | undefined {
  const name = takeDbFlag(argv) ?? env.ASKDB_DB;
  if (!name) return undefined;

  if (!PROFILE_NAME.test(name)) {
    throw new Error(`Invalid --db name "${name}": use letters, digits, "-" or "_" (it selects the file .env.<name>)`);
  }
  const file = path.join(rootDir, `.env.${name}`);
  if (!existsSync(file)) {
    throw new Error(`--db ${name}: settings file ${file} not found`);
  }
  Object.assign(env, parseEnv(readFileSync(file, 'utf8')));
  env.ASKDB_DB = name;
  return name;
}

/** Finds `--db name` or `--db=name`, removes it from argv, and returns the name. */
function takeDbFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--db=')) {
      argv.splice(i, 1);
      return arg.slice('--db='.length);
    }
    if (arg === '--db') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--db needs a name, e.g. --db dvdrental');
      argv.splice(i, 2);
      return value;
    }
  }
  return undefined;
}
