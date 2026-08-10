import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createIsolatedPackageTestDatabase } from './helpers/isolated-database.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDb = BASE_URL ? describe : describe.skip;

function maintenanceUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  url.searchParams.delete('options');
  return url.toString();
}

describeIfDb('isolated package test database recovery', () => {
  it('removes a stale database and preserves a concurrently active one', async () => {
    if (!BASE_URL) throw new Error('test database was not configured');

    const namespace = 'recovery_regression';
    const staleName = `sqworker_${randomBytes(6).toString('hex')}_${namespace}`;
    const admin = postgres(maintenanceUrl(BASE_URL), { max: 1, onnotice: () => undefined });
    const active = await createIsolatedPackageTestDatabase(BASE_URL, namespace);
    let replacement: Awaited<ReturnType<typeof createIsolatedPackageTestDatabase>> | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE "${staleName}"`);
      replacement = await createIsolatedPackageTestDatabase(BASE_URL, namespace);

      const rows = await admin<
        { datname: string }[]
      >`SELECT datname FROM pg_database WHERE datname = ANY(${[active.name, staleName, replacement.name]}) ORDER BY datname`;
      expect(rows.map(({ datname }) => datname)).toEqual([active.name, replacement.name].sort());
    } finally {
      await replacement?.drop();
      await active.drop();
      await admin
        .unsafe(`DROP DATABASE IF EXISTS "${staleName}" WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end();
    }
  }, 120_000);
});
