import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 40_000,
    setupFiles: ['../_test-shared/load-env.ts'],
  },
});
