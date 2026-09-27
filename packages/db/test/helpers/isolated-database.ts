import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ADVISORY_LOCK_NAMESPACE = 0x5351_0000;
/**
 * Joins a package database name to a clone's slot label. Namespaces are
 * single-underscore snake_case, so a double underscore can only ever start a
 * clone suffix and a sweep can tell a run's clones from another namespace.
 */
const CLONE_SEPARATOR = '__';
const CLONE_SLOT_RE = /^[a-z0-9]+$/;
const PACKAGE_DATABASE_NAME_RE = /^sqworker_[0-9a-f]{12}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
// SQLSTATE 42P04: the slot's clone already exists, created by an earlier file
// that ran in the same Vitest worker slot.
const DUPLICATE_DATABASE = '42P04';
// SQLSTATE 55006: another session is connected to the template. PostgreSQL
// already waits ~5 s for it to leave (and stops autovacuum on the template)
// before raising this, so a few retries cover a transient connection.
const OBJECT_IN_USE = '55006';
const CLONE_ATTEMPTS = 3;
/** The package's real migration folder, as applied in production. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle/', import.meta.url));

type SqlClient = ReturnType<typeof postgres>;

/** A per-worker copy of a package database, dropped together with its template. */
export interface PackageTestDatabaseClone {
  /** `<template name>__<slot>`, recognized by the template's own sweeps. */
  name: string;
  /** Connection URL targeting the clone. */
  url: string;
}

/** A migrated database owned exclusively by one package test run. */
export interface IsolatedPackageTestDatabase {
  /** Strict ephemeral database name recognized by the API stale-resource sweeper. */
  name: string;
  /** Connection URL targeting the isolated database. */
  url: string;
  /** Drops the database and its clones, then releases its crash-recovery advisory lock. */
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

/**
 * Removes a crashed run's template and clones. A run's session advisory lock
 * is held for as long as its template lives, so a lock this sweep can take
 * belongs to a process that is gone.
 */
async function sweepStalePackageDatabases(sql: SqlClient, namespace: string): Promise<void> {
  const pattern = `^sqworker_([0-9a-f]{12})_${namespace}(?:${CLONE_SEPARATOR}[a-z0-9]+)?$`;
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
 * The database can serve as the template of {@link clonePackageTestDatabase};
 * `drop()` then removes its clones as well.
 *
 * @param baseUrl - Any URL on the target PostgreSQL server.
 * @param namespace - Lowercase snake_case suffix naming the owning test.
 * @param options.throughMigration - Journal tag to stop at instead of applying
 *   every migration, for upgrade tests.
 * @returns The database and a `drop()` that removes it and its clones.
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
    // Loaded here, not at module scope: every test file's setup imports this
    // module for clonePackageTestDatabase(), and drizzle's migrator alone costs
    // it about 0.3 s per file.
    const [{ drizzle }, { migrate }] = await Promise.all([
      import('drizzle-orm/postgres-js'),
      import('drizzle-orm/postgres-js/migrator'),
    ]);
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
          const clones = await admin<{ datname: string }[]>`
            SELECT datname FROM pg_database
            WHERE datname ~ ${`^${name}${CLONE_SEPARATOR}[a-z0-9]+$`}`;
          for (const { datname } of clones) {
            await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
          }
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

/**
 * Gives one Vitest worker slot its own copy of a migrated package database.
 *
 * `CREATE DATABASE … TEMPLATE` copies the template at the storage layer in a
 * fraction of a second, where replaying every migration takes seconds. Files
 * that run at the same time always occupy different slots, so they never
 * share rows; files that run one after another in one slot reuse its clone,
 * exactly as every file of a package used to share one database. The clone is
 * not dropped here: the template's `drop()` and the crashed-run sweep of
 * {@link createIsolatedPackageTestDatabase} both remove it.
 *
 * Nothing may stay connected to the template, or PostgreSQL refuses the copy.
 *
 * @param templateUrl - URL of a database created by
 *   {@link createIsolatedPackageTestDatabase}.
 * @param slot - Lowercase alphanumeric label unique among the template's
 *   concurrently used clones, e.g. `w3` for Vitest pool slot 3.
 * @returns The slot's clone, created on first use and reused afterwards.
 * @throws If the template name or slot is malformed, the clone name exceeds
 *   PostgreSQL's 63-byte limit, or the template stays in use by another session.
 */
export async function clonePackageTestDatabase(
  templateUrl: string,
  slot: string,
): Promise<PackageTestDatabaseClone> {
  const template = decodeURIComponent(new URL(templateUrl).pathname.slice(1));
  if (!PACKAGE_DATABASE_NAME_RE.test(template)) {
    throw new Error(`${template} is not an isolated package test database`);
  }
  if (!CLONE_SLOT_RE.test(slot)) throw new Error('clone slot must be lowercase alphanumeric');
  const name = `${template}${CLONE_SEPARATOR}${slot}`;
  if (name.length > 63) {
    throw new Error('package test database clone name exceeds PostgreSQL limits');
  }

  const admin = postgres(databaseUrl(templateUrl, 'postgres'), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === DUPLICATE_DATABASE) break;
        if (code !== OBJECT_IN_USE || attempt >= CLONE_ATTEMPTS) throw error;
      }
    }
  } finally {
    await admin.end();
  }
  return { name, url: databaseUrl(templateUrl, name) };
}
