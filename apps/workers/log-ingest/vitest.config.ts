import { defineConfig } from 'vitest/config';

// Every worker slot holds its own database clone, Redis database and
// connection pools, so the slot count is what a run costs the shared servers;
// CI lowers it through VITEST_MAX_FORKS when several packages run at once.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4;

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    poolOptions: { forks: { maxForks, minForks: 1 } },
    testTimeout: 10_000,
    // Files run in parallel: the global setup migrates one template per run and
    // every worker slot gets its own clone of it and its own Redis database, so
    // two files inserting the same fixture players never meet (dc3e18ff).
    setupFiles: [
      '../_test-shared/load-env.ts',
      '../../../packages/db/test/helpers/clone-per-worker.ts',
      '../_test-shared/redis-per-worker.ts',
    ],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        lines: 31,
        functions: 68,
        branches: 74,
        statements: 31,
      },
      reportsDirectory: './coverage',
    },
  },
});
