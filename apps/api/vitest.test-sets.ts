/**
 * Splits the API test files into the ones that need Postgres or Redis and the
 * ones that do not, by reading them. `vitest.unit.config.ts` runs the second
 * set without any service; the full `vitest.config.ts` still runs everything.
 *
 * The split is computed, never listed: a hand-kept list of unit files would
 * drift the moment someone adds a test, and a test that fell off the list would
 * silently stop running in the local gate. `test/test-sets.guard.test.ts` pins
 * the partition so a file can neither sit in both sets nor in neither.
 *
 * A file needs services when its own source, or the source of any support file
 * it imports (transitively, under `test/` or `packages/db/test/helpers/`),
 * names the integration harness, a database or Redis URL, or a service gate.
 * Imports into `src/` are not followed: application modules read their
 * configuration from injected options, and a test that really connects through
 * one still names the URL or harness itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `apps/api`. */
export const API_ROOT = path.dirname(fileURLToPath(import.meta.url));

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.cache']);

/**
 * Words that mark a file as needing Postgres or Redis. Deliberately
 * over-inclusive, like `WORKER_DATABASE_REFERENCE` in `isolated-db.ts`: a false
 * positive keeps one file out of the fast local set, a false negative makes the
 * local gate fail on a missing service.
 */
const SERVICE_MARKER = new RegExp(
  [
    'buildIntegrationApp',
    'reusePublicSchema',
    'createDatabaseClient',
    'describeIf(?:Db|Redis|DbAndRedis)',
    'DATABASE_URL',
    'REDIS_URL',
    'hostDbUrl',
    'ensureWorkerDatabase',
  ].join('|'),
);

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|importActual|importMock)\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Directories whose files count as test support, relative to the repository root. */
function supportRoots(apiRoot: string): string[] {
  return [path.join(apiRoot, 'test'), path.resolve(apiRoot, '../../packages/db/test/helpers')];
}

function isUnder(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolves a relative import the way this repository writes them: `./x.js` names `./x.ts`. */
function resolveImport(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
    base,
  ];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/**
 * Lists every API test file Vitest would collect with the package's default
 * `include`, minus `test/e2e/**` (excluded by `vitest.config.ts`).
 *
 * @param apiRoot - Absolute path of the API package.
 * @returns Package-relative POSIX paths, sorted.
 */
export function listApiTestFiles(apiRoot: string = API_ROOT): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(full);
      } else if (TEST_FILE.test(entry.name)) {
        found.push(path.relative(apiRoot, full).split(path.sep).join('/'));
      }
    }
  };
  visit(apiRoot);
  return found.filter((file) => !file.startsWith('test/e2e/')).sort();
}

/**
 * Decides whether a test file needs Postgres or Redis, from its source and the
 * test-support files it imports.
 *
 * @param file - Path of the test file, relative to `apiRoot`.
 * @param apiRoot - Absolute path of the API package.
 * @returns True when the file or a support file it pulls in carries a service marker.
 */
export function needsServices(file: string, apiRoot: string = API_ROOT): boolean {
  const roots = supportRoots(apiRoot);
  const visited = new Set<string>();
  const pending = [path.join(apiRoot, file)];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, 'utf-8');
    if (SERVICE_MARKER.test(source)) return true;
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveImport(current, match[1] as string);
      if (resolved && roots.some((root) => isUnder(resolved, root))) pending.push(resolved);
    }
  }
  return false;
}

/** The API test files, split by whether they need Postgres or Redis. */
export interface ApiTestSets {
  /** Files that run with no service available. */
  unit: string[];
  /** Files that need Postgres and/or Redis; only the full suite runs them. */
  services: string[];
}

/**
 * Partitions every API test file into the service-free set and the rest.
 *
 * @param apiRoot - Absolute path of the API package.
 * @returns Both sets as sorted package-relative POSIX paths; together they are exactly {@link listApiTestFiles}.
 */
export function partitionApiTests(apiRoot: string = API_ROOT): ApiTestSets {
  const sets: ApiTestSets = { unit: [], services: [] };
  for (const file of listApiTestFiles(apiRoot)) {
    (needsServices(file, apiRoot) ? sets.services : sets.unit).push(file);
  }
  return sets;
}
