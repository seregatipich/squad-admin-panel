import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fullConfig from '../vitest.config.js';
import {
  API_ROOT,
  listApiTestFiles,
  needsServices,
  partitionApiTests,
} from '../vitest.test-sets.js';
import unitConfig from '../vitest.unit.config.js';

// The service markers are assembled from parts on purpose: this file is itself
// a unit test, and a literal marker would make the classifier send it to the
// service set, where the local gate never runs it.
const HARNESS_CALL = ['build', 'IntegrationApp'].join('');
const DATABASE_VARIABLE = ['DATABASE', 'URL'].join('_');
const REDIS_VARIABLE = ['REDIS', 'URL'].join('_');
const SERVICE_GATE = ['describe', 'If', 'Db'].join('');

describe('API test sets (vitest.unit.config.ts)', () => {
  describe('partition of the real test tree', () => {
    const all = listApiTestFiles();
    const { unit, services } = partitionApiTests();

    it('puts every test file in exactly one set, so none can fall between them', () => {
      expect(all.length).toBeGreaterThan(0);
      expect([...unit, ...services].sort()).toEqual(all);
      expect(unit.filter((file) => services.includes(file))).toEqual([]);
    });

    it('lists the same files the full suite collects: no include override, only test/e2e excluded', () => {
      const full = fullConfig.test ?? {};
      expect(full.include).toBeUndefined();
      expect(full.exclude).toEqual(['**/node_modules/**', '**/dist/**', 'test/e2e/**']);
      expect(all.some((file) => file.startsWith('test/e2e/'))).toBe(false);
    });

    it('runs exactly the unit set from the unit config, with no service-backed setup', () => {
      const unitTest = unitConfig.test ?? {};
      expect(unitTest.include).toEqual(unit);
      expect(unitTest.globalSetup).toBeUndefined();
      expect(unitTest.setupFiles).toBeUndefined();
    });

    it('keeps the service-free guards in the unit set and a harness-backed file out', () => {
      expect(unit).toContain('test/test-isolation.regression.test.ts');
      expect(unit).toContain('test/route-registration-parity.test.ts');
      expect(unit).toContain('test/audit-coverage.test.ts');
      expect(unit).toContain('test/test-sets.guard.test.ts');
      expect(services).toContain('test/integration/harness.test.ts');
    });
  });

  describe('classification', () => {
    let root: string;
    const write = (relative: string, source: string): void => {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    };

    beforeAll(() => {
      root = mkdtempSync(path.join(tmpdir(), 'api-test-sets-'));
      write('test/pure.test.ts', "import { x } from '../src/lib/x.js';\n");
      write('test/names-database.test.ts', `const url = process.env.${DATABASE_VARIABLE};\n`);
      write('test/names-redis.test.ts', `const url = process.env.${REDIS_VARIABLE};\n`);
      write('test/uses-gate.test.ts', `${SERVICE_GATE}('suite', () => {});\n`);
      write('test/uses-harness.test.ts', `await ${HARNESS_CALL}();\n`);
      write('test/helpers/clean.ts', 'export const clean = 1;\n');
      write('test/helpers/dirty.ts', `export const db = ${HARNESS_CALL};\n`);
      write('test/helpers/via-dirty.ts', "export { db } from './dirty.js';\n");
      write('test/imports-clean-helper.test.ts', "import { clean } from './helpers/clean.js';\n");
      write('test/imports-dirty-helper.test.ts', "import { db } from './helpers/dirty.js';\n");
      write('test/imports-dirty-transitively.test.ts', "import './helpers/via-dirty.js';\n");
      write(
        'test/dynamic-import.test.ts',
        "const helper = await import('./helpers/dirty.js');\nvoid helper;\n",
      );
      write('test/mocks-dirty.test.ts', "vi.mock('./helpers/dirty.js');\n");
      write('test/import-cycle-a.test.ts', "import './helpers/cycle-a.js';\n");
      write('test/helpers/cycle-a.ts', "import './cycle-b.js';\n");
      write('test/helpers/cycle-b.ts', "import './cycle-a.js';\n");
      write('src/lib/x.ts', `export const x = process.env.${DATABASE_VARIABLE};\n`);
      write('src/lib/inline.test.ts', 'export {};\n');
      write('test/e2e/live.e2e.test.ts', 'export {};\n');
      write('node_modules/dep/skipped.test.ts', 'export {};\n');
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([
      ['a test naming the database URL', 'test/names-database.test.ts'],
      ['a test naming the Redis URL', 'test/names-redis.test.ts'],
      ['a test using a service gate', 'test/uses-gate.test.ts'],
      ['a test building the integration harness', 'test/uses-harness.test.ts'],
      ['a test importing a support file that does', 'test/imports-dirty-helper.test.ts'],
      ['a test reaching one through a re-export', 'test/imports-dirty-transitively.test.ts'],
      ['a test loading one with a dynamic import', 'test/dynamic-import.test.ts'],
      ['a test mocking one', 'test/mocks-dirty.test.ts'],
    ])('sends %s to the service set', (_name, file) => {
      expect(needsServices(file, root)).toBe(true);
    });

    it.each([
      ['a test with no service marker', 'test/pure.test.ts'],
      ['a test importing only clean support files', 'test/imports-clean-helper.test.ts'],
      ['a test whose imports form a cycle', 'test/import-cycle-a.test.ts'],
    ])('keeps %s in the unit set', (_name, file) => {
      expect(needsServices(file, root)).toBe(false);
    });

    it('does not follow imports into application sources', () => {
      expect(needsServices('test/pure.test.ts', root)).toBe(false);
    });

    it('lists test files outside test/ too, and skips test/e2e and node_modules', () => {
      expect(listApiTestFiles(root)).not.toContain('test/e2e/live.e2e.test.ts');
      expect(listApiTestFiles(root)).not.toContain('node_modules/dep/skipped.test.ts');
      expect(listApiTestFiles(root)).toContain('src/lib/inline.test.ts');
    });

    it('partitions the fixture tree with nothing lost', () => {
      const { unit, services } = partitionApiTests(root);
      expect([...unit, ...services].sort()).toEqual(listApiTestFiles(root));
      expect(unit).toContain('test/pure.test.ts');
      expect(services).toContain('test/imports-dirty-helper.test.ts');
    });
  });

  it('resolves the package root to the directory holding vitest.config.ts', () => {
    expect(path.basename(API_ROOT)).toBe('api');
    expect(listApiTestFiles()).toContain('test/test-sets.guard.test.ts');
  });
});
