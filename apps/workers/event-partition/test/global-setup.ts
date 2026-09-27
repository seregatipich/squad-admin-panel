// Resolves DATABASE_URL from the repo `.env`, as each test file's `load-env.ts`
// does, before the template is built from it.
import '../../_test-shared/load-env.js';
import type { TestProject } from 'vitest/node';
import { setupPackageTemplateDatabase } from '../../../../packages/db/test/helpers/package-template.js';

/** Migrates the event-partition package's template once; each worker slot gets a clone of it. */
export default function setupEventPartitionTestDatabase(
  project: TestProject,
): Promise<() => Promise<void>> {
  if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
  }
  return setupPackageTemplateDatabase(project, 'event_partition');
}
