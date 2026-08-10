import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    testTimeout: 10_000,
    setupFiles: ['../_test-shared/load-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        lines: 12,
        functions: 68,
        branches: 77,
        statements: 12,
      },
      reportsDirectory: './coverage',
    },
  },
});
