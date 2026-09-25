import { afterAll, expect, inject } from 'vitest';
import {
  provisionWorkerResources,
  releaseWorkerResources,
  testFileUsesWorkerDatabase,
  useRunId,
  useSharedTemplate,
} from './isolated-db.js';

const runId = (inject as (key: string) => string | undefined)('squadRunId');
if (runId) useRunId(runId);

const template = (inject as (key: string) => string | undefined)('squadTemplateDb');
if (template) useSharedTemplate(template);

// Cloning (and later dropping) a database for every file cost ~340 ms of setup
// per file, yet only files that name the worker database connect to it; the
// rest defer the clone until something calls ensureWorkerDatabase() (the
// reusePublicSchema harness does). Vitest sets testPath before setup files run.
await provisionWorkerResources({
  database: testFileUsesWorkerDatabase(expect.getState().testPath),
});

afterAll(async () => {
  await releaseWorkerResources();
});
