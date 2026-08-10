import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10_000,
    setupFiles: ['../_test-shared/load-env.ts'],
    fileParallelism: false,
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
