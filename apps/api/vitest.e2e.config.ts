import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    // Real docker run + steamcmd validate + Squad boot easily pushes past
    // the default 10 s limit; give installs up to 15 min and individual
    // assertions 2 min. Reconcile-via-docker-inspect loops are generous.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // Serial so port allocation and docker labels don't collide between
    // tests. We're not racing for coverage here, we're proving correctness.
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['verbose'],
  },
});
