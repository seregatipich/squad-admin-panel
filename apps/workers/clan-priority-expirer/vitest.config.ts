import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 40_000,
    // The integration files share one database: a tick enqueues a sync for
    // every active server, which races another file deleting its server.
    fileParallelism: false,
    setupFiles: ['../_test-shared/load-env.ts'],
  },
});
