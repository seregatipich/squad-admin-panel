import { createIsolatedPackageTestDatabase } from '../../../../packages/db/test/helpers/isolated-database.js';

/** Provisions one migrated database for the complete clan-guard test process. */
export default async function setupClanGuardTestDatabase(): Promise<() => Promise<void>> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) return async () => undefined;

  const isolated = await createIsolatedPackageTestDatabase(baseUrl, 'clan_guard');
  process.env.DATABASE_URL = isolated.url;
  process.env.TEST_DATABASE_URL = isolated.url;
  return () => isolated.drop();
}
