/**
 * Vitest setup file: points `DATABASE_URL` and `TEST_DATABASE_URL` at this
 * worker slot's clone of the run's package template (see `package-template.ts`).
 *
 * Setup files run before a test file's own imports, so module-scope reads of
 * `DATABASE_URL` already see the clone. `VITEST_POOL_ID` names a slot that at
 * most one test file occupies at a time, which is what lets files run in
 * parallel without sharing rows.
 */
import { inject } from 'vitest';
import { clonePackageTestDatabase } from './isolated-database.js';

const templateUrl = inject('squadPackageTemplateUrl');
if (templateUrl === undefined) {
  // Without the template the files would run in parallel against one shared
  // database, the very collision this setup exists to prevent.
  throw new Error(
    'clone-per-worker.ts needs a globalSetup that calls setupPackageTemplateDatabase()',
  );
}
if (templateUrl) {
  const clone = await clonePackageTestDatabase(
    templateUrl,
    `w${process.env.VITEST_POOL_ID ?? '1'}`,
  );
  process.env.DATABASE_URL = clone.url;
  process.env.TEST_DATABASE_URL = clone.url;
}
