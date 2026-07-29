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
  const admin = postgres(hostDbUrl(), { max: 1, onnotice: () => undefined });
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
  const admin = postgres(hostDbUrl(), { max: 1, onnotice: () => undefined });
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
    async drop() {
      const admin = postgres(hostDbUrl(), { max: 1, onnotice: () => undefined });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}

let workerResources: Promise<void> | null = null;

/**
 * Per-worker isolation hook invoked by `worker-setup.ts` before any test in a
 * Vitest worker runs. Points the worker at its own cloned database and a
 * dedicated Redis logical DB so parallel workers never share mutable Postgres
 * or Redis state — preserving the serial suite's isolation while allowing files
 * to run in parallel across workers. Idempotent per worker process.
 */
export function provisionWorkerResources(): Promise<void> {
  if (!workerResources) workerResources = doProvisionWorkerResources();
  return workerResources;
}

async function doProvisionWorkerResources(): Promise<void> {
  const workerId = Number(process.env.VITEST_WORKER_ID ?? '1');

  const redisUrl = new URL(hostRedisUrl());
  redisUrl.pathname = `/${8 + (workerId % 8)}`;
  const redisTarget = redisUrl.toString();
  const flushClient = new Redis(redisTarget);
  try {
    await flushClient.flushdb();
  } finally {
    await flushClient.quit();
  }
  process.env.TEST_REDIS_URL = redisTarget;

  const template = await ensureTemplateDatabase();
  const name = `sqworker_${currentRunId()}_${process.pid}_${randomBytes(4).toString('hex')}`;
  await cloneTemplate(name, template);
  const url = databaseUrl(name);
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
