import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    testTimeout: 40_000,
    setupFiles: ['../_test-shared/load-env.ts'],
  },
});
