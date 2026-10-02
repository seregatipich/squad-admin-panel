// Resolves DATABASE_URL from the repo `.env`, as each test file's `load-env.ts`
// does, before the template is built from it.
import '../../_test-shared/load-env.js';
import type { TestProject } from 'vitest/node';
import { setupPackageTemplateDatabase } from '../../../../packages/db/test/helpers/package-template.js';

/**
 * Migrates the event-partition package's template once; each worker slot gets a clone of it.
 * Without a database URL it provides no template, and the suites gate themselves with
 * `describeIfDb`: skipped locally, a hard failure under `CI`.
 */
export default function setupEventPartitionTestDatabase(
  project: TestProject,
): Promise<() => Promise<void>> {
  return setupPackageTemplateDatabase(project, 'event_partition');
}
