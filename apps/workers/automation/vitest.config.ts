import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 40_000,
    setupFiles: ['../_test-shared/load-env.ts'],
    // Several suites here (contract.test.ts's subprocess, plugin-dispatch.test.ts's
    // real-Redis dispatch loop) share one local Redis instance; running test
    // files in parallel causes contention that makes contract.test.ts's tight
    // shutdown-timing assertion flaky (mirrors worker-log-ingest/db configs).
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
