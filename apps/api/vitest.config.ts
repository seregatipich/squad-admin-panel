import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
    globalSetup: ['./test/integration/global-setup.ts'],
    setupFiles: ['./test/integration/worker-setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
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
