import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const ADVISORY_LOCK_NAMESPACE = 0x5351_0000;
/** The package's real migration folder, as applied in production. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle/', import.meta.url));

type SqlClient = ReturnType<typeof postgres>;

/** A migrated database owned exclusively by one package test run. */
export interface IsolatedPackageTestDatabase {
  /** Strict ephemeral database name recognized by the API stale-resource sweeper. */
  name: string;
  /** Connection URL targeting the isolated database. */
  url: string;
  /** Drops the database and releases its crash-recovery advisory lock. */
  drop(): Promise<void>;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('options');
  return url.toString();
}

function signedInt32(value: number): number {
  return value > 0x7fff_ffff ? value - 0x1_0000_0000 : value;
}

function advisoryLockKeys(runId: string): readonly [number, number] {
  const high = Number.parseInt(runId.slice(0, 4), 16);
  const low = Number.parseInt(runId.slice(4), 16);
  return [ADVISORY_LOCK_NAMESPACE + high, signedInt32(low)];
}

async function releaseLock(sql: SqlClient, keys: readonly [number, number]): Promise<void> {
  const [row] = await sql<{ released: boolean }[]>`
    SELECT pg_advisory_unlock(${keys[0]}, ${keys[1]}) AS released`;
  if (!row?.released) throw new Error('isolated package test database lock was lost');
}

async function sweepStalePackageDatabases(sql: SqlClient, namespace: string): Promise<void> {
  const pattern = `^sqworker_([0-9a-f]{12})_${namespace}$`;
  const rows = await sql<{ datname: string; run_id: string }[]>`
    SELECT datname, substring(datname FROM ${pattern}) AS run_id
    FROM pg_database
    WHERE datname ~ ${pattern}`;

  for (const { datname, run_id: runId } of rows) {
    const keys = advisoryLockKeys(runId);
    const [lock] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${keys[0]}, ${keys[1]}) AS acquired`;
    if (!lock?.acquired) continue;

    try {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    } finally {
      await releaseLock(sql, keys);
    }
  }
}

/**
 * Copies the migration folder into a temporary directory whose journal stops at
 * `lastTag`, so a test can build the schema a production database had before a
 * later migration and then apply the real folder on top of it.
 *
 * @param lastTag - Journal tag of the last migration to keep, e.g. `0114_chat_source_rcon`.
 * @returns The truncated folder and a cleanup that removes it.
 * @throws If `lastTag` is not in the journal.
 */
async function truncatedMigrationsFolder(
  lastTag: string,
): Promise<{ folder: string; cleanup: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'squad-db-migrations-'));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const lastIndex = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (lastIndex === -1) {
    await rm(folder, { recursive: true, force: true });
    throw new Error(`migration ${lastTag} is not in the journal`);
  }
  journal.entries = journal.entries.slice(0, lastIndex + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}

/**
 * Creates and migrates a database isolated from every other Turbo package.
 * A session advisory lock preserves live databases while a later run of the
 * same package removes strict-name leftovers from a crashed process.
 *
 * @param baseUrl - Any URL on the target PostgreSQL server.
 * @param namespace - Lowercase snake_case suffix naming the owning test.
 * @param options.throughMigration - Journal tag to stop at instead of applying
 *   every migration, for upgrade tests.
 * @returns The database and a `drop()` that removes it.
 */
export async function createIsolatedPackageTestDatabase(
  baseUrl: string,
  namespace: string,
  options: { throughMigration?: string } = {},
): Promise<IsolatedPackageTestDatabase> {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(namespace)) {
    throw new Error('package test database namespace must be lowercase alphanumeric snake_case');
  }

  const runId = randomBytes(6).toString('hex');
  const name = `sqworker_${runId}_${namespace}`;
  if (name.length > 63) throw new Error('package test database name exceeds PostgreSQL limits');

  const maintenanceUrl = databaseUrl(baseUrl, 'postgres');
  const keys = advisoryLockKeys(runId);
  const admin = postgres(maintenanceUrl, {
    idle_timeout: 0,
    max: 1,
    max_lifetime: 0,
    onnotice: () => undefined,
  });
  let lockAcquired = false;

  try {
    const [lock] = await admin<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${keys[0]}, ${keys[1]}) AS acquired`;
    if (!lock?.acquired) throw new Error(`package test database namespace ${runId} is active`);
    lockAcquired = true;
    await sweepStalePackageDatabases(admin, namespace);
    await admin.unsafe(`CREATE DATABASE "${name}"`);

    const url = databaseUrl(baseUrl, name);
    const migrationSql = postgres(url, { max: 1, onnotice: () => undefined });
    const truncated = options.throughMigration
      ? await truncatedMigrationsFolder(options.throughMigration)
      : null;
    try {
      await migrate(drizzle(migrationSql), {
        migrationsFolder: truncated?.folder ?? MIGRATIONS_FOLDER,
      });
    } finally {
      await migrationSql.end().catch(() => undefined);
      await truncated?.cleanup();
    }

    let dropped = false;
    return {
      name,
      url,
      async drop() {
        if (dropped) return;
        dropped = true;
        const errors: unknown[] = [];
        try {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        } catch (error) {
          errors.push(error);
        }
        try {
          await releaseLock(admin, keys);
          lockAcquired = false;
        } catch (error) {
          errors.push(error);
        }
        await admin.end().catch((error) => errors.push(error));
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, `failed to drop isolated package database ${name}`);
        }
      },
    };
  } catch (error) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    if (lockAcquired) await releaseLock(admin, keys).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }
}
