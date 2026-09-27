import { defineConfig } from 'vitest/config';

// Every worker slot holds its own database clone and connection pools, so the
// slot count is what a run costs the Postgres connection budget; CI lowers it
// through VITEST_MAX_FORKS when several packages share one server.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4;

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Files run in parallel: the global setup migrates one template per run
    // and every worker slot works on its own clone of it, so files that run at
    // the same time never share rows.
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/helpers/clone-per-worker.ts'],
    pool: 'forks',
    poolOptions: { forks: { maxForks, minForks: 1 } },
    hookTimeout: 120_000,
    testTimeout: 20_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        lines: 72,
        functions: 12,
        branches: 45,
        statements: 72,
      },
      reportsDirectory: './coverage',
    },
  },
});
