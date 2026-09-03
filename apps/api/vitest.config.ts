import { defineConfig } from 'vitest/config';

// Bounded worker count keeps parallel database clones within the Postgres
// connection budget; overridable via VITEST_MAX_FORKS so a memory-constrained
// CI runner can lower it.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4;

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
    globalSetup: ['./test/integration/global-setup.ts'],
    setupFiles: ['./test/integration/worker-setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 120_000,
    isolate: true,
    sequence: { concurrent: false, hooks: 'stack' },
    pool: 'forks',
    poolOptions: { forks: { maxForks, minForks: 1 } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
      reportsDirectory: './coverage',
    },
  },
});
