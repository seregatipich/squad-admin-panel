import { afterAll, inject } from 'vitest';
import {
  provisionWorkerResources,
  releaseWorkerResources,
  useRunId,
  useSharedTemplate,
} from './isolated-db.js';

const runId = (inject as (key: string) => string | undefined)('squadRunId');
if (runId) useRunId(runId);

const template = (inject as (key: string) => string | undefined)('squadTemplateDb');
if (template) useSharedTemplate(template);

await provisionWorkerResources();

afterAll(async () => {
  await releaseWorkerResources();
});
