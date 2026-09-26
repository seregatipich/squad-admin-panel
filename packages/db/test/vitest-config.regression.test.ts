// Регрессия: DB integration tests используют общие fixtures public-схемы. Файлы
// идут параллельно только потому, что каждый слот воркера получает свой клон
// мигрированного шаблона — без этой пары настроек параллельные файлы снова
// делили бы одну базу.
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

type TestConfig = {
  globalSetup?: string[];
  setupFiles?: string[];
  fileParallelism?: boolean;
  poolOptions?: { forks?: { maxForks?: number } };
  sequence?: { concurrent?: boolean };
  testTimeout?: number;
  hookTimeout?: number;
};

const cfg = (vitestConfig as { test?: TestConfig }).test;

describe('vitest config invariants', () => {
  it('migrates one package template before tests run', () => {
    expect(cfg?.globalSetup).toContain('./test/global-setup.ts');
  });

  it('gives every worker slot its own clone of the template', () => {
    expect(cfg?.setupFiles).toContain('./test/helpers/clone-per-worker.ts');
  });

  it('runs files in parallel now that no two concurrent files share a database', () => {
    expect(cfg?.fileParallelism).not.toBe(false);
  });

  it('bounds the worker slots, and so the clones, by VITEST_MAX_FORKS', () => {
    expect(cfg?.poolOptions?.forks?.maxForks).toBe(Number(process.env.VITEST_MAX_FORKS) || 4);
  });

  it('sequence.concurrent is false', () => {
    expect(cfg?.sequence?.concurrent).toBe(false);
  });

  it('testTimeout has headroom for coverage runs under root workspace load', () => {
    expect(cfg?.testTimeout).toBeGreaterThanOrEqual(20_000);
  });

  it('global setup has enough time to create and migrate the package database', () => {
    expect(cfg?.hookTimeout).toBeGreaterThanOrEqual(120_000);
  });
});
