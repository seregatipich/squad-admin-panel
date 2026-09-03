// regression: parallel test files once raced on a shared DB + shared Redis, causing
// flaky failures, so file parallelism was disabled. Each isolated file now gets
// its own cloned database and dedicated Redis logical DB (see worker-setup.ts),
// and each integration test clones its own database (see harness.ts), so
// parallelism is safe. These invariants keep tests within a file sequential,
// provision and release the file-level resources, sweep interrupted-run orphans,
// and bound worker count so parallel clones do not exhaust Postgres connections.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

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
