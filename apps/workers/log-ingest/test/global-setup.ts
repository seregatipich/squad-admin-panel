// Resolves DATABASE_URL from the repo `.env`, as each test file's `load-env.ts`
// does, before the template is built from it.
import '../../_test-shared/load-env.js';
import type { TestProject } from 'vitest/node';
import { setupPackageTemplateDatabase } from '../../../../packages/db/test/helpers/package-template.js';

/** Migrates the log-ingest package's template once; each worker slot gets a clone of it. */
export default function setupLogIngestTestDatabase(
  project: TestProject,
): Promise<() => Promise<void>> {
  return setupPackageTemplateDatabase(project, 'log_ingest');
}
