import { createIsolatedPackageTestDatabase } from '../../../../packages/db/test/helpers/isolated-database.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');

  const isolated = await createIsolatedPackageTestDatabase(baseUrl, 'event_partition');
  process.env.DATABASE_URL = isolated.url;
  process.env.TEST_DATABASE_URL = isolated.url;
  return () => isolated.drop();
}
