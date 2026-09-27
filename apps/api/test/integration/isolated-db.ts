import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import postgres from 'postgres';

// Lightweight per-test database/Redis isolation, deliberately free of any route
// or plugin imports. `worker-setup.ts` loads only this module before a test
// file's `vi.mock()` calls run, so pulling it in never pre-populates the module
// registry with the real route modules that tests mock.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../../packages/db/drizzle');
const REPO_ENV_FILE = path.resolve(__dirname, '../../../../.env');

function dotenvLookup(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const raw = readFileSync(REPO_ENV_FILE, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (m && m[1] === key) return m[2]?.replace(/^"(.*)"$/, '$1');
    }
  } catch {
    // .env missing is fine; caller must set env
  }
  return undefined;
}

/**
 * Resolves the Postgres password for the default `admin`/`admin@127.0.0.1:5432`
 * fallback URL. Throws instead of guessing when `POSTGRES_PASSWORD`,
 * `DATABASE_URL`, and the repo `.env` all fail to resolve one — silently
 * defaulting to the literal string `admin` masked a genuinely misconfigured
 * environment as a connection that "just happens" to work. Called lazily, only
 * from inside the `TEST_DATABASE_URL` short-circuits below, so a correctly
 * configured run that sets `TEST_DATABASE_URL` directly never evaluates it.
 */
function resolveDbPassword(): string {
  const fromEnvVar = dotenvLookup('POSTGRES_PASSWORD');
  if (fromEnvVar) return fromEnvVar;

  const url = dotenvLookup('DATABASE_URL');
  if (url) {
    const m = url.match(/^postgres:\/\/[^:]+:([^@]+)@/);
    if (m) return m[1];
  }

  throw new Error(
    'Could not resolve a Postgres password: POSTGRES_PASSWORD is unset, DATABASE_URL has ' +
      'no embedded password, and the repo .env file is missing or has no POSTGRES_PASSWORD ' +
      'entry. Set TEST_DATABASE_URL (or POSTGRES_PASSWORD/DATABASE_URL) explicitly instead of ' +
      'relying on the default admin/admin@127.0.0.1:5432 fallback.',
  );
}

function defaultDbUrl(): string {
  return `postgres://admin:${resolveDbPassword()}@127.0.0.1:5432/admin`;
}

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/15';

// Read per call so the per-worker setup hook can point each worker at its own
// isolated database and Redis logical DB before tests run.
export function hostDbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? defaultDbUrl();
}
export function hostRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? DEFAULT_REDIS_URL;
}

// Frozen at module load for the main-process globalSetup sweep; workers override
// their own env after this runs, but any connection reaches the same cluster.
export const testDbUrl = process.env.TEST_DATABASE_URL ?? defaultDbUrl();
export const testRedisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_REDIS_URL;

export interface CreatedSchema {
  schema: string;
  url: string;
  drop: () => Promise<void>;
}

type SqlClient = ReturnType<typeof postgres>;

function databaseUrl(name: string): string {
  const url = new URL(hostDbUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

// CREATE/DROP DATABASE run from the cluster's always-present `postgres`
// maintenance database: inside a test worker TEST_DATABASE_URL names the file's
// own worker database, which is only cloned on demand and may not exist yet.
function maintenanceDbUrl(): string {
  return databaseUrl('postgres');
}

async function dropDatabase(name: string): Promise<void> {
  const admin = postgres(maintenanceDbUrl(), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

let migrationStatementsCache: string[] | null = null;

/**
 * Reads every `.sql` file under `packages/db/drizzle/`, in lexical order, and
 * flattens them into an ordered list of statements. The `.sql` files are split
 * on the `--> statement-breakpoint` marker that drizzle-kit emits when a
 * migration contains multiple top-level statements. Parsed once per process.
 */
function migrationStatements(): string[] {
  if (migrationStatementsCache) return migrationStatementsCache;
  const statements: string[] = [];
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const contents = readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf-8').replace(
      /\bpublic\./gi,
      '',
    );
    for (const stmt of contents
      .split(/-->\s*statement-breakpoint\s*/i)
      .map((s) => s.trim())
      .filter(Boolean)) {
      statements.push(stmt);
    }
  }
  migrationStatementsCache = statements;
  return statements;
}

async function applyMigrations(sql: SqlClient): Promise<void> {
  await sql.unsafe('SET client_min_messages = WARNING');
  for (const stmt of migrationStatements()) {
    await sql.unsafe(stmt);
  }
}

let injectedTemplate: string | null = null;
let templateDatabase: Promise<string> | null = null;
let runId: string | null = null;

/**
 * Registers the shared template built once by `global-setup.ts` and passed to
 * each worker via Vitest's `inject`. When set, workers clone from it directly
 * instead of migrating their own template — the migration runs exactly once for
 * the whole suite.
 */
export function useSharedTemplate(name: string): void {
  injectedTemplate = name;
}

/**
 * Registers the per-run id generated once by `global-setup.ts` and passed to
 * each worker via Vitest's `inject`. Embedded into every database name this
 * module constructs so a concurrently-running session's own `dropTestDatabases`
 * sweep — which is cluster-wide by nature — never touches this run's databases.
 */
export function useRunId(id: string): void {
  runId = id;
}

/**
 * Resolves the active run id, falling back to a per-process id for callers
 * running without `global-setup.ts` (e.g. a lone worker started outside the
 * suite's normal `globalSetup`/`inject` wiring).
 */
function currentRunId(): string {
  return runId ?? `p${process.pid}`;
}

/**
 * Builds a fresh template database migrated exactly once. Called by
 * `global-setup.ts` to produce the single shared template for the run.
 */
export function buildSharedTemplate(): Promise<string> {
  return buildTemplateDatabase(`sqtmpl_${currentRunId()}_shared_${randomBytes(6).toString('hex')}`);
}

/**
 * Resolves the `TEMPLATE` source used to clone every isolated database. Prefers
 * the shared template injected by `global-setup.ts`; otherwise builds a
 * per-process one (fallback for callers running without the global setup).
 * Cloning with `CREATE DATABASE … TEMPLATE` copies the template at the storage
 * layer in ~80ms, versus ~2.5s to replay 40+ migrations.
 */
function ensureTemplateDatabase(): Promise<string> {
  if (injectedTemplate) return Promise.resolve(injectedTemplate);
  if (!templateDatabase) {
    templateDatabase = buildTemplateDatabase(
      `sqtmpl_${currentRunId()}_${process.pid}_${randomBytes(4).toString('hex')}`,
    );
  }
  return templateDatabase;
}

async function buildTemplateDatabase(name: string): Promise<string> {
  const admin = postgres(maintenanceDbUrl(), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const sql = postgres(databaseUrl(name), { max: 1, onnotice: () => undefined });
  try {
    await applyMigrations(sql);
  } finally {
    await sql.end();
  }
  return name;
}

async function cloneTemplate(target: string, template: string): Promise<void> {
  const admin = postgres(maintenanceDbUrl(), { max: 1, onnotice: () => undefined });
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE "${target}" TEMPLATE "${template}"`);
        return;
      } catch (error) {
        lastError = error;
        // 55006: template is being accessed by another CREATE DATABASE clone.
        if ((error as { code?: string }).code !== '55006') throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 + 25 * (attempt % 8)));
      }
    }
    throw lastError;
  } finally {
    await admin.end();
  }
}

/**
 * Provisions a fully isolated, migrated database by cloning the shared template.
 * Kept named `createIsolatedSchema` for API compatibility; the returned `schema`
 * field now holds the database name.
 */
export async function createIsolatedSchema(): Promise<CreatedSchema> {
  const template = await ensureTemplateDatabase();
  const name = `sqtest_${currentRunId()}_${randomBytes(6).toString('hex')}`;
  await cloneTemplate(name, template);
  return {
    schema: name,
    url: databaseUrl(name),
    drop: () => dropDatabase(name),
  };
}

// `process.env.DATABASE_URL ? describe : describe.skip` only asks whether a
// database is configured at all, so on its own it does not make a file a user
// of the worker database.
const DATABASE_URL_PRESENCE_GATE =
  /process\.env\.DATABASE_URL\s*\?\s*describe\s*:\s*describe\.skip/g;
const WORKER_DATABASE_REFERENCE = /DATABASE_URL|hostDbUrl|reusePublicSchema/;

/**
 * Decides from a test file's source whether it reaches the per-file worker
 * database: by reading `DATABASE_URL`/`TEST_DATABASE_URL`, calling
 * `hostDbUrl()`, or building a `reusePublicSchema` harness. Deliberately
 * over-inclusive — any other mention counts, even in a comment — because the
 * two mistakes are not symmetric: a false positive costs one clone, while a
 * false negative leaves the file pointed at a worker database that does not
 * exist yet, which fails loudly ("database … does not exist") and can never
 * fall through to a database another file is using.
 *
 * @param source - The test file's TypeScript source.
 * @returns Whether the worker database must be cloned before the file loads.
 */
export function sourceUsesWorkerDatabase(source: string): boolean {
  return WORKER_DATABASE_REFERENCE.test(source.replace(DATABASE_URL_PRESENCE_GATE, ''));
}

/**
 * Applies {@link sourceUsesWorkerDatabase} to the test file at `testPath`. An
 * unknown or unreadable file counts as a user, so the fallback is the eager
 * clone every file used to get.
 *
 * @param testPath - Absolute path of the test file about to run, if known.
 * @returns Whether the worker database must be cloned before the file loads.
 */
export function testFileUsesWorkerDatabase(testPath: string | undefined): boolean {
  if (!testPath) return true;
  try {
    return sourceUsesWorkerDatabase(readFileSync(testPath, 'utf-8'));
  } catch {
    return true;
  }
}

/**
 * Maps a Vitest pool slot (`VITEST_POOL_ID`, 1..maxForks) to the Redis logical
 * DB a file flushes and uses. Pool ids are unique among files running at the
 * same time; `VITEST_WORKER_ID` is not — it grows with every file, so keying
 * on it let a file started eight files after a still-running one flush the
 * same logical DB underneath it. Distinct for up to eight forks, the bound the
 * vitest config regression test pins.
 *
 * @param poolId - The `VITEST_POOL_ID` of the fork running the file.
 * @returns A Redis logical DB index in 8..15.
 */
export function workerRedisDatabase(poolId: number): number {
  return 8 + (poolId % 8);
}

interface WorkerDatabase {
  name: string;
  url: string;
  clone: Promise<void> | null;
}

let workerResources: Promise<void> | null = null;
let workerDatabase: WorkerDatabase | null = null;

export interface ProvisionWorkerResourcesOptions {
  /**
   * Clone the worker database now (the default). When false the clone waits
   * for the first {@link ensureWorkerDatabase} call; `DATABASE_URL` and
   * `TEST_DATABASE_URL` name the file's own database either way.
   */
  database?: boolean;
}

/**
 * File-isolation hook invoked by `worker-setup.ts` before a Vitest file runs:
 * flushes the file's Redis logical DB and points `TEST_REDIS_URL` at it, and
 * points `DATABASE_URL`/`TEST_DATABASE_URL` at a database name that belongs to
 * this file alone. Vitest evaluates setupFiles in each isolated file context,
 * so the matching afterAll hook must release the clone before that context
 * disappears. Files running in parallel never share mutable Postgres or Redis
 * state.
 *
 * @param options - Whether to clone the worker database now or on demand.
 */
export async function provisionWorkerResources(
  options: ProvisionWorkerResourcesOptions = {},
): Promise<void> {
  if (!workerResources) workerResources = doProvisionWorkerResources();
  await workerResources;
  if (options.database ?? true) await ensureWorkerDatabase();
}

/**
 * Clones the worker database that `DATABASE_URL`/`TEST_DATABASE_URL` name from
 * the shared template on the first call; later and concurrent calls share that
 * single clone. Outside a provisioned worker (e.g. the e2e config) there is no
 * worker database and the configured URL is returned unchanged.
 *
 * @returns The URL `TEST_DATABASE_URL` points at, now backed by a database.
 */
export async function ensureWorkerDatabase(): Promise<string> {
  if (workerResources) await workerResources;
  const target = workerDatabase;
  if (!target) return hostDbUrl();
  if (!target.clone) {
    target.clone = ensureTemplateDatabase().then((template) =>
      cloneTemplate(target.name, template),
    );
  }
  await target.clone;
  return target.url;
}

/**
 * @returns This file's worker database name, or null outside a provisioned
 *   worker. The database itself exists only once {@link ensureWorkerDatabase}
 *   has run.
 */
export function workerDatabaseName(): string | null {
  return workerDatabase?.name ?? null;
}

/** Drops the worker database if it was ever cloned; safe to call repeatedly. */
export async function releaseWorkerResources(): Promise<void> {
  const database = workerDatabase;
  workerResources = null;
  workerDatabase = null;
  if (!database?.clone) return;
  // Settle an in-flight clone first so the drop cannot overtake CREATE DATABASE.
  await database.clone.catch(() => undefined);
  await dropDatabase(database.name);
}

async function doProvisionWorkerResources(): Promise<void> {
  const poolId = Number(process.env.VITEST_POOL_ID ?? '1');
  const redisUrl = new URL(hostRedisUrl());
  redisUrl.pathname = `/${workerRedisDatabase(poolId)}`;
  const redisTarget = redisUrl.toString();
  const flushClient = new Redis(redisTarget);
  try {
    await flushClient.flushdb();
  } finally {
    await flushClient.quit();
  }
  process.env.TEST_REDIS_URL = redisTarget;

  const name = `sqworker_${currentRunId()}_${process.pid}_${randomBytes(4).toString('hex')}`;
  const url = databaseUrl(name);
  workerDatabase = { name, url, clone: null };
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_URL = url;
}

/**
 * Idempotent migration entry point. Databases produced by
 * `createIsolatedSchema` are cloned from an already-migrated template, so this
 * is a no-op for them; it only replays the DDL against a genuinely empty target.
 */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const [row] = await sql<{ migrated: boolean }[]>`
      SELECT to_regclass('players') IS NOT NULL AS migrated`;
    if (row?.migrated) return;
    await applyMigrations(sql);
  } finally {
    await sql.end();
  }
}
