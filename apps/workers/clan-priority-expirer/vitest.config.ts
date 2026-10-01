import { defineConfig } from 'vitest/config';
import { workerTestBase } from '../_test-shared/vitest.base';

export default defineConfig({
  test: {
    ...workerTestBase,
    // The integration files share one database: a tick enqueues a sync for
    // every active server, which races another file deleting its server.
    fileParallelism: false,
  },
});
