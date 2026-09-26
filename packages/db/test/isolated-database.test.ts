import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  clonePackageTestDatabase,
  createIsolatedPackageTestDatabase,
  type IsolatedPackageTestDatabase,
  type PackageTestDatabaseClone,
} from './helpers/isolated-database.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = BASE_URL ? describe : describe.skip;

function maintenanceUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  url.searchParams.delete('options');
  return url.toString();
}

async function existingDatabases(
  admin: ReturnType<typeof postgres>,
  names: string[],
): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname = ANY(${names}) ORDER BY datname`;
  return rows.map(({ datname }) => datname);
}

describeIfDb('isolated package test database recovery', () => {
  it('removes a stale database and its clones and preserves a concurrently active one', async () => {
    if (!BASE_URL) throw new Error('test database was not configured');

    const namespace = 'recovery_regression';
    // Sweeping is about names and locks, not schema: stopping at the first
    // migration saves replaying the whole chain twice.
    const options = { throughMigration: '0000_init' };
    const staleName = `sqworker_${randomBytes(6).toString('hex')}_${namespace}`;
    const staleClone = `${staleName}__w1`;
    const admin = postgres(maintenanceUrl(BASE_URL), { max: 1, onnotice: () => undefined });
    const active = await createIsolatedPackageTestDatabase(BASE_URL, namespace, options);
    let replacement: IsolatedPackageTestDatabase | undefined;

    try {
      const activeClone = await clonePackageTestDatabase(active.url, 'w1');
      await admin.unsafe(`CREATE DATABASE "${staleName}"`);
      await admin.unsafe(`CREATE DATABASE "${staleClone}"`);
      replacement = await createIsolatedPackageTestDatabase(BASE_URL, namespace, options);

      const names = [active.name, activeClone.name, staleName, staleClone, replacement.name];
      expect(await existingDatabases(admin, names)).toEqual(
        [active.name, activeClone.name, replacement.name].sort(),
      );

      // Dropping a template takes the clones its worker slots left behind with it.
      await active.drop();
      expect(await existingDatabases(admin, names)).toEqual([replacement.name]);
    } finally {
      await replacement?.drop();
      await active.drop();
      for (const name of [staleClone, staleName]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      }
      await admin.end();
    }
  }, 120_000);
});

describeIfDb('package test database clones', () => {
  // Slot labels no Vitest pool slot (`w<n>`) uses, so these clones of the
  // run's own template never touch a database another test file is using.
  const slot = (label: string) => `t${label}${randomBytes(4).toString('hex')}`;
  const created: PackageTestDatabaseClone[] = [];
  let templateUrl: string;
  let admin: ReturnType<typeof postgres>;

  async function clone(label: string): Promise<PackageTestDatabaseClone> {
    const result = await clonePackageTestDatabase(templateUrl, slot(label));
    created.push(result);
    return result;
  }

  beforeAll(() => {
    if (!BASE_URL) throw new Error('test database was not configured');
    const provided = inject('squadPackageTemplateUrl');
    if (!provided) throw new Error('db package template was not provided');
    templateUrl = provided;
    admin = postgres(maintenanceUrl(BASE_URL), { max: 1, onnotice: () => undefined });
  });

  afterAll(async () => {
    for (const { name } of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin?.end();
  });

  it('copies the migrated schema and seed rows under a slot-scoped name', async () => {
    const copy = await clone('a');
    const template = new URL(templateUrl).pathname.slice(1);
    expect(copy.name).toMatch(new RegExp(`^${template}__ta[0-9a-f]{8}$`));
    expect(new URL(copy.url).pathname).toBe(`/${copy.name}`);

    const sql = postgres(copy.url, { max: 1, onnotice: () => undefined });
    try {
      const [migrations] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      const [systemRoles] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM roles WHERE is_system_role`;
      expect(migrations?.count).toBeGreaterThan(100);
      expect(systemRoles?.count).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  });

  it('reuses a slot clone and keeps concurrently used slots apart', async () => {
    const label = slot('b');
    const first = await clonePackageTestDatabase(templateUrl, label);
    created.push(first);
    const writer = postgres(first.url, { max: 1, onnotice: () => undefined });
    try {
      await writer`CREATE TABLE slot_marker (id int)`;
      await writer`INSERT INTO slot_marker VALUES (2)`;
    } finally {
      await writer.end();
    }

    const again = await clonePackageTestDatabase(templateUrl, label);
    const other = await clone('c');
    expect(again).toEqual(first);

    const reader = postgres(again.url, { max: 1, onnotice: () => undefined });
    const neighbour = postgres(other.url, { max: 1, onnotice: () => undefined });
    try {
      expect(await reader`SELECT id FROM slot_marker`).toEqual([{ id: 2 }]);
      const [row] = await neighbour<{ exists: boolean }[]>`
        SELECT to_regclass('slot_marker') IS NOT NULL AS exists`;
      expect(row?.exists).toBe(false);
    } finally {
      await reader.end();
      await neighbour.end();
    }
  });

  it('creates clones of one template concurrently', async () => {
    const clones = await Promise.all(['d', 'e', 'f'].map((label) => clone(label)));
    expect(
      await existingDatabases(
        admin,
        clones.map(({ name }) => name),
      ),
    ).toHaveLength(3);
  });

  it('rejects a template that is not an isolated package database', async () => {
    const url = new URL(templateUrl);
    url.pathname = '/admin';
    await expect(clonePackageTestDatabase(url.toString(), 'w1')).rejects.toThrow(
      'admin is not an isolated package test database',
    );
  });

  it('rejects a slot that could collide with another namespace', async () => {
    await expect(clonePackageTestDatabase(templateUrl, 'w_1')).rejects.toThrow(
      'clone slot must be lowercase alphanumeric',
    );
  });

  it('rejects a clone name beyond the PostgreSQL identifier limit', async () => {
    await expect(clonePackageTestDatabase(templateUrl, 'w'.repeat(40))).rejects.toThrow(
      'package test database clone name exceeds PostgreSQL limits',
    );
  });
});
