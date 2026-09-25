// regression: parallel test files once raced on a shared DB + shared Redis, causing
// flaky failures, so file parallelism was disabled. Each isolated file now gets
// its own worker database name and a Redis logical DB keyed by its pool slot
// (see worker-setup.ts), and each integration test clones its own database (see
// harness.ts), so parallelism is safe. The worker database is cloned before the
// file loads only when the file names it; every other file defers the clone to
// ensureWorkerDatabase(), which saves a clone + drop for most files. These
// invariants keep tests within a file sequential, provision and release the
// file-level resources, sweep interrupted-run orphans, and bound worker count so
// parallel clones do not exhaust Postgres connections.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';
import {
  sourceUsesWorkerDatabase,
  testDbUrl,
  testFileUsesWorkerDatabase,
  workerDatabaseName,
} from './integration/isolated-db.js';

const turboConfig = JSON.parse(
  readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'),
) as { globalPassThroughEnv?: string[] };
const strykerConfig = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared-config/stryker.config.json', import.meta.url),
    'utf8',
  ),
) as { concurrency?: number };

const cfg = (
  vitestConfig as {
    test?: {
      isolate?: boolean;
      sequence?: { concurrent?: boolean; hooks?: string };
      poolOptions?: { forks?: { maxForks?: number } };
      globalSetup?: string[];
      setupFiles?: string[];
    };
  }
).test;

describe('vitest config invariants', () => {
  it('sequence.concurrent is false', () => {
    expect(cfg?.sequence?.concurrent).toBe(false);
  });

  it('keeps setup state isolated and releases its resources after file hooks', () => {
    expect(cfg?.isolate).toBe(true);
    expect(cfg?.sequence?.hooks).toBe('stack');
  });

  it('worker count is bounded to protect the connection budget', () => {
    const maxForks = cfg?.poolOptions?.forks?.maxForks;
    expect(typeof maxForks).toBe('number');
    expect(maxForks).toBeGreaterThan(0);
    // Eight pool slots map onto the eight Redis logical DBs 8..15 one-to-one.
    expect(maxForks).toBeLessThanOrEqual(8);
  });

  it('forwards the local worker override through Turbo without changing cache keys', () => {
    expect(turboConfig.globalPassThroughEnv).toContain('VITEST_MAX_FORKS');
  });

  it('bounds mutation workers on a shared development machine', () => {
    expect(strykerConfig.concurrency).toBe(2);
  });

  it('provisions file-level isolation via setupFiles', () => {
    expect(cfg?.setupFiles).toContain('./test/integration/worker-setup.ts');
  });

  it('sweeps orphan test databases via globalSetup', () => {
    expect(cfg?.globalSetup).toContain('./test/integration/global-setup.ts');
  });
});

describe('worker database provisioning', () => {
  it('clones the worker database before a file that names DATABASE_URL loads', async () => {
    // This file names process.env.DATABASE_URL (here), so worker-setup.ts had
    // to clone the database both variables point at before collecting it.
    const name = workerDatabaseName();
    const workerUrl = process.env.TEST_DATABASE_URL;
    if (!name || !workerUrl) throw new Error('worker-setup.ts did not assign a worker database');
    expect(new URL(workerUrl).pathname).toBe(`/${name}`);
    expect(process.env.DATABASE_URL).toBe(workerUrl);

    const admin = postgres(testDbUrl, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await admin<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${name}) AS exists`;
      expect(row?.exists).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it('does not count the describeIfDb presence gate as a use', () => {
    expect(
      sourceUsesWorkerDatabase(
        [
          "import { buildIntegrationApp } from './integration/harness.js';",
          'const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;',
          'const h = await buildIntegrationApp({ seedOwner: { steamId64: 1n } });',
        ].join('\n'),
      ),
    ).toBe(false);
    expect(sourceUsesWorkerDatabase('')).toBe(false);
  });

  it.each([
    ['a direct DATABASE_URL read', 'const dbUrl = process.env.DATABASE_URL;'],
    ['a TEST_DATABASE_URL read', "const url = process.env['TEST_DATABASE_URL'];"],
    ['hostDbUrl()', 'const sql = postgres(hostDbUrl());'],
    ['the reusePublicSchema harness', 'await buildIntegrationApp({ reusePublicSchema: true });'],
    [
      'a read next to the presence gate',
      [
        'const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;',
        'beforeAll(() => { sql = postgres(process.env.DATABASE_URL!); });',
      ].join('\n'),
    ],
  ])('counts %s as a use', (_label, source) => {
    expect(sourceUsesWorkerDatabase(source)).toBe(true);
  });

  it('classifies test files by path and falls back to cloning when it cannot tell', () => {
    const here = fileURLToPath(import.meta.url);
    const lazyLifecycleSuite = fileURLToPath(
      new URL('./integration/worker-resource-cleanup.test.ts', import.meta.url),
    );

    expect(testFileUsesWorkerDatabase(here)).toBe(true);
    expect(testFileUsesWorkerDatabase(lazyLifecycleSuite)).toBe(false);
    expect(testFileUsesWorkerDatabase(undefined)).toBe(true);
    expect(testFileUsesWorkerDatabase(`${here}.missing`)).toBe(true);
  });
});
