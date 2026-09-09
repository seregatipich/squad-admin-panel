import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 40_000,
    setupFiles: ['../_test-shared/load-env.ts'],
    // Files run one at a time: `contract.test.ts` boots the real worker against
    // this package's database, and that worker runs a partition tick on startup.
    // In parallel it recreates the very partitions `partition.test.ts` drops and
    // asserts on, so the two race. All files here share one database, so
    // serialising them is the only way to keep partition assertions meaningful.
    fileParallelism: false,
  },
});
