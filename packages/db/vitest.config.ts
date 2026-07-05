import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20_000,
    fileParallelism: false,
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
