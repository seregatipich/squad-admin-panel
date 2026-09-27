import type { TestProject } from 'vitest/node';
import { createIsolatedPackageTestDatabase } from './isolated-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * URL of the run's migrated package template, or `null` when no database
     * is configured and the package's DB-backed tests skip themselves.
     */
    squadPackageTemplateUrl: string | null;
  }
}

/**
 * Vitest `globalSetup` body for a package whose test files run in parallel,
 * each worker slot on its own copy of one migrated database.
 *
 * Migrations are replayed exactly once per run, into a template database the
 * `clone-per-worker.ts` setup file copies for every worker slot. The template's
 * URL reaches the workers through Vitest's `provide`/`inject` rather than
 * `DATABASE_URL`, so no test ever connects to the template itself — PostgreSQL
 * refuses to copy a database that has other sessions.
 *
 * @param project - The Vitest project handed to the `globalSetup` function.
 * @param namespace - Lowercase snake_case package name embedded in every
 *   database name of the run, e.g. `log_ingest`.
 * @returns The teardown that drops the template and all its clones.
 * @throws If the template cannot be created or migrated.
 */
export async function setupPackageTemplateDatabase(
  project: Pick<TestProject, 'provide'>,
  namespace: string,
): Promise<() => Promise<void>> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    project.provide('squadPackageTemplateUrl', null);
    return async () => undefined;
  }

  const template = await createIsolatedPackageTestDatabase(baseUrl, namespace);
  project.provide('squadPackageTemplateUrl', template.url);
  return () => template.drop();
}
