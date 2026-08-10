import { createIsolatedPackageTestDatabase } from '../../../../packages/db/test/helpers/isolated-database.js';

/** Provisions one migrated database for the complete log-ingest test process. */
export default async function setupLogIngestTestDatabase(): Promise<() => Promise<void>> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) return async () => undefined;

  const isolated = await createIsolatedPackageTestDatabase(baseUrl, 'log_ingest');
  process.env.DATABASE_URL = isolated.url;
  process.env.TEST_DATABASE_URL = isolated.url;
  return () => isolated.drop();
}
