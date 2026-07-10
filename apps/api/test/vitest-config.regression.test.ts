// regression: parallel test files once raced on a shared DB + shared Redis, causing
// flaky failures, so file parallelism was disabled. Each worker now gets its own
// cloned database and dedicated Redis logical DB (see worker-setup.ts), and each
// integration test clones its own database (see harness.ts), so parallelism is safe.
// These invariants keep the isolation guarantees intact: tests within a file stay
// sequential, the per-worker setup runs, orphan databases are swept, and worker
// count stays bounded so parallel clones do not exhaust Postgres connections.
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

const cfg = (
  vitestConfig as {
    test?: {
      sequence?: { concurrent?: boolean };
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

  it('worker count is bounded to protect the connection budget', () => {
    const maxForks = cfg?.poolOptions?.forks?.maxForks;
    expect(typeof maxForks).toBe('number');
    expect(maxForks).toBeGreaterThan(0);
    expect(maxForks).toBeLessThanOrEqual(8);
  });

  it('provisions per-worker isolation via setupFiles', () => {
    expect(cfg?.setupFiles).toContain('./test/integration/worker-setup.ts');
  });

  it('sweeps orphan test databases via globalSetup', () => {
    expect(cfg?.globalSetup).toContain('./test/integration/global-setup.ts');
  });
});
