import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E tests live under test/e2e/ and hit a live panel stack over HTTP.
    // Skip them by default because they require docker + real Squad depot;
    // run with: pnpm --filter @squad/api test:e2e
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 30_000,
  },
});
