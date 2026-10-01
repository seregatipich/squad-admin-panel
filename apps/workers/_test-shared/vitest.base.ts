/**
 * Vitest `test` options shared by the workers whose suites need nothing beyond
 * the repo's `.env` defaults. A worker's `vitest.config.ts` spreads this into
 * `defineConfig({ test: { ...workerTestBase, ...overrides } })`.
 *
 * Plain values, no `vitest` import: this file sits outside every package, so
 * it cannot resolve a package's own `vitest`. The `setupFiles` path is
 * relative to the Vitest root, i.e. the worker package directory.
 */
export const workerTestBase = {
  exclude: ['**/node_modules/**', '**/dist/**'],
  testTimeout: 40_000,
  setupFiles: ['../_test-shared/load-env.ts'],
};
