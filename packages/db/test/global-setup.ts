import { createIsolatedPackageTestDatabase } from './helpers/isolated-database.js';

/** Provisions one migrated database for the complete db package test process. */
export default async function setupDbTestDatabase(): Promise<() => Promise<void>> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) return async () => undefined;

  const isolated = await createIsolatedPackageTestDatabase(baseUrl, 'db');
  process.env.DATABASE_URL = isolated.url;
  process.env.TEST_DATABASE_URL = isolated.url;
  return () => isolated.drop();
}
