import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E tests live under test/e2e/ and hit a live panel stack over HTTP.
    // Skip them by default because they require docker + real Squad depot;
    // run with: pnpm --filter @squad/api test:e2e
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 30_000,
    // RBAC integration tests share the live Postgres DB. Run files serially
    // so cross-file mutations (players.role_id, roles, panel_meta) don't race.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
