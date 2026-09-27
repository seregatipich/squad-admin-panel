import type { TestProject } from 'vitest/node';
import { setupPackageTemplateDatabase } from './helpers/package-template.js';

/** Migrates the db package's template once; each worker slot gets a clone of it. */
export default function setupDbTestDatabase(project: TestProject): Promise<() => Promise<void>> {
  return setupPackageTemplateDatabase(project, 'db');
}
