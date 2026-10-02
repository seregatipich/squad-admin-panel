import { defineConfig } from 'vitest/config';
import { partitionApiTests } from './vitest.test-sets.js';

// The API tests that need neither Postgres nor Redis (see vitest.test-sets.ts
// for how they are told apart from the rest). There is deliberately no
// globalSetup and no setup file: the full config's ones build a migrated
// template database and clone one per worker, which is exactly what this run
// must not need. Selecting by content instead of by directory keeps the set
// current as tests are added. The timeout is wider than the full suite's:
// audit-coverage.test.ts needs about seven seconds to load every route on an
// idle machine, and this run is meant for a developer's busy laptop.
export default defineConfig({
  test: {
    include: partitionApiTests().unit,
    testTimeout: 30_000,
    isolate: true,
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
