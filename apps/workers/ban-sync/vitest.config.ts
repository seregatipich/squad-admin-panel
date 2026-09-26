import { defineConfig } from 'vitest/config';

// Every worker slot holds its own Redis database and connections; CI lowers
// the slot count through VITEST_MAX_FORKS when several packages run at once.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4;

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    poolOptions: { forks: { maxForks, minForks: 1 } },
    testTimeout: 40_000,
    // Each worker slot gets its own Redis database: `contract.test.ts` and
    // `shutdown.regression.test.ts` both spawn the worker, which shares one
    // heartbeat key and one manual-queue stream across processes.
    setupFiles: ['../_test-shared/load-env.ts', '../_test-shared/redis-per-worker.ts'],
  },
});
