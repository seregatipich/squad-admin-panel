import { defineConfig } from 'vitest/config';

// Every worker slot holds its own database clone, Redis database and
// connection pools, so the slot count is what a run costs the shared servers;
// CI lowers it through VITEST_MAX_FORKS when several packages run at once.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4;

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    poolOptions: { forks: { maxForks, minForks: 1 } },
    // Files run in parallel: the global setup migrates one template per run and
    // every worker slot gets its own clone of it and its own Redis database, so
    // the startup tick of the worker `contract.test.ts` spawns never grants the
    // reward `tick.integration.test.ts` is asserting on.
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 40_000,
    setupFiles: [
      '../_test-shared/load-env.ts',
      '../../../packages/db/test/helpers/clone-per-worker.ts',
      '../_test-shared/redis-per-worker.ts',
    ],
  },
});
