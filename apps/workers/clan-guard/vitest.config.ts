import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    setupFiles: ['../_test-shared/load-env.ts'],
    testTimeout: 40_000,
  },
});
