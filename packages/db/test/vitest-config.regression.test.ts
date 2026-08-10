// Регрессия: DB integration tests используют общие fixtures public-схемы и
// не должны запускать test files параллельно.
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

describe('vitest config invariants', () => {
  it('provisions an isolated package database before tests run', () => {
    const cfg = (vitestConfig as { test?: { globalSetup?: string[] } }).test;
    expect(cfg?.globalSetup).toContain('./test/global-setup.ts');
  });

  it('fileParallelism is false for shared DB integration tests', () => {
    const cfg = (vitestConfig as { test?: { fileParallelism?: boolean } }).test;
    expect(cfg?.fileParallelism).toBe(false);
  });

  it('sequence.concurrent is false', () => {
    const cfg = (vitestConfig as { test?: { sequence?: { concurrent?: boolean } } }).test;
    expect(cfg?.sequence?.concurrent).toBe(false);
  });

  it('testTimeout has headroom for coverage runs under root workspace load', () => {
    const cfg = (vitestConfig as { test?: { testTimeout?: number } }).test;
    expect(cfg?.testTimeout).toBeGreaterThanOrEqual(20_000);
  });

  it('global setup has enough time to create and migrate the package database', () => {
    const cfg = (vitestConfig as { test?: { hookTimeout?: number } }).test;
    expect(cfg?.hookTimeout).toBeGreaterThanOrEqual(120_000);
  });
});
