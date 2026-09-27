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
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 40_000,
    // Files run in parallel on per-worker-slot clones of one migrated template.
    // `contract.test.ts` boots the real worker, whose startup partition tick
    // recreates the partitions `partition.test.ts` drops and asserts on; the
    // two can only meet on one database when they run one after another in
    // the same slot, never at the same time.
    setupFiles: [
      '../_test-shared/load-env.ts',
      '../../../packages/db/test/helpers/clone-per-worker.ts',
      '../_test-shared/redis-per-worker.ts',
    ],
  },
});
