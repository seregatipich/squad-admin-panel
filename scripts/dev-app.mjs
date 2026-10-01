#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: dotenv-style references, expanded by expandReferences
/**
 * `pnpm dev:app` — the API and the web dev server, configured from the repository
 * `.env`, running against the compose Postgres and Redis through their published
 * host ports.
 *
 * Environment resolution, lowest to highest precedence:
 *
 *   1. `.env`
 *   2. the host-reachable defaults below (`.env` carries the compose-internal
 *      hosts `postgres`/`redis` and the production `PANEL_PUBLIC_URL`, none of
 *      which work from a process on the host)
 *   3. `.env.local` (optional, gitignored)
 *   4. variables already set in the shell
 *
 * `${NAME}` and `${NAME:-fallback}` references in values are expanded against the
 * final result, so `.env.local` can reuse `${POSTGRES_PASSWORD}` from `.env`.
 * Node's own `--env-file` is not used: it does not expand references, and
 * `--env-file-if-exists` needs Node 22.9 while `engines` allows 22.0.
 *
 * Usage: `node scripts/dev-app.mjs [--print]`. `--print` prints the resolved
 * settings (passwords masked) and exits without starting anything.
 *
 * @module scripts/dev-app
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Settings the host-side processes need. Raw strings, so they are expanded
 * together with the files' values and a `.env.local` that overrides `WEB_PORT`
 * moves `PANEL_PUBLIC_URL` with it.
 */
const HOST_DEFAULTS = {
  API_HOST: '127.0.0.1',
  API_PORT: '3001',
  WEB_PORT: '3000',
  API_URL: 'http://localhost:${API_PORT}',
  PANEL_PUBLIC_URL: 'http://localhost:${WEB_PORT}',
  DATABASE_URL: 'postgres://admin:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/admin',
  REDIS_URL: 'redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_HOST_PORT:-6379}',
};

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Reads a dotenv file with Node's parser.
 *
 * @param file - Absolute path.
 * @returns The parsed variables, or `null` when the file does not exist.
 */
function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : null;
}

/**
 * Expands `${NAME}` / `${NAME:-fallback}` in every value of `raw`.
 *
 * @param raw - Unexpanded variables.
 * @param shell - The calling environment. A non-empty value there wins over
 *   `raw` and is taken literally; it is also the source for names `raw` does not
 *   define (for example `HOME`).
 * @returns The same keys with every reference replaced; an unset or empty name
 *   becomes its fallback, or the empty string.
 * @throws If values reference each other in a cycle.
 */
export function expandReferences(raw, shell = {}) {
  const resolved = {};
  const visiting = new Set();
  const lookup = (name) => {
    if (shell[name]) return shell[name];
    if (!(name in raw)) return '';
    if (name in resolved) return resolved[name];
    if (visiting.has(name)) throw new Error(`circular reference through ${name}`);
    visiting.add(name);
    resolved[name] = raw[name].replace(REFERENCE, (_match, ref, fallback) => {
      const value = lookup(ref);
      return value === '' ? (fallback ?? '') : value;
    });
    visiting.delete(name);
    return resolved[name];
  };
  for (const name of Object.keys(raw)) lookup(name);
  return Object.fromEntries(Object.keys(raw).map((name) => [name, lookup(name)]));
}

/**
 * Resolves the environment `dev:app` gives its child processes.
 *
 * @param options.rootDir - Repository root holding `.env` and `.env.local`.
 * @param options.shell - The calling shell's environment; its non-empty values win over both files.
 * @returns `files` (the dotenv files that were read), `overrides` (the variables
 *   to add on top of `shell`), `apiPort` and `webPort`.
 */
export function resolveDevEnvironment({ rootDir = ROOT_DIR, shell = process.env } = {}) {
  const dotenv = readEnvFile(path.join(rootDir, '.env'));
  const local = readEnvFile(path.join(rootDir, '.env.local'));
  const overrides = expandReferences({ ...dotenv, ...HOST_DEFAULTS, ...local }, shell);
  return {
    files: [dotenv && '.env', local && '.env.local'].filter(Boolean),
    overrides,
    apiPort: overrides.API_PORT,
    webPort: overrides.WEB_PORT,
  };
}

/**
 * Names the settings the API cannot start without that are still blank.
 *
 * @param overrides - The resolved variables.
 * @returns The names to fill in `.env`; empty when nothing is missing.
 */
export function missingSecrets(overrides) {
  const missing = ['APP_ENCRYPTION_KEY', 'SESSION_SECRET'].filter((name) => !overrides[name]);
  if (/\/\/[^:@/]*:@/.test(overrides.DATABASE_URL ?? '')) missing.push('POSTGRES_PASSWORD');
  if (/\/\/[^:@/]*:@/.test(overrides.REDIS_URL ?? '') && !overrides.REDIS_PASSWORD) {
    missing.push('REDIS_PASSWORD');
  }
  return missing;
}

const maskPassword = (url) => url.replace(/(\/\/[^:@/]*:)[^@]*@/, '$1***@');

/**
 * Summarises what the processes will use, without secrets.
 *
 * @param resolved - The result of {@link resolveDevEnvironment}.
 * @returns A JSON-serialisable object.
 */
export function describeResolved({ files, overrides, apiPort, webPort }) {
  return {
    files,
    api: `http://${overrides.API_HOST}:${apiPort}`,
    web: `http://localhost:${webPort}`,
    API_URL: overrides.API_URL,
    PANEL_PUBLIC_URL: overrides.PANEL_PUBLIC_URL,
    DATABASE_URL: maskPassword(overrides.DATABASE_URL),
    REDIS_URL: maskPassword(overrides.REDIS_URL),
  };
}

function main(argv) {
  const resolved = resolveDevEnvironment();
  const missing = missingSecrets(resolved.overrides);
  if (!resolved.files.includes('.env')) {
    console.error('dev:app: .env not found — run `cp .env.example .env` and fill in the secrets.');
    return 1;
  }
  if (missing.length > 0) {
    console.error(`dev:app: fill in ${missing.join(', ')} in .env (see .env.example).`);
    return 1;
  }
  console.log(JSON.stringify(describeResolved(resolved), null, 2));
  if (argv.includes('--print')) return 0;

  // --parallel: the two dev scripts are independent watchers, and pnpm prefixes
  // each line with the package that printed it.
  const child = spawn(
    'pnpm',
    ['--parallel', '--filter', '@squad/api', '--filter', '@squad/web', 'dev'],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, ...resolved.overrides, PORT: resolved.webPort },
      stdio: 'inherit',
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 1));
  return null;
}

// Node resolves symlinks in import.meta.url (macOS /var → /private/var), so the
// entry path has to be resolved the same way before comparing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const status = main(process.argv.slice(2));
  if (status !== null) process.exit(status);
}
