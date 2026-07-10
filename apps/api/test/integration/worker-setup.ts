import { inject } from 'vitest';
import { provisionWorkerResources, useSharedTemplate } from './isolated-db.js';

const template = (inject as (key: string) => string | undefined)('squadTemplateDb');
if (template) useSharedTemplate(template);

await provisionWorkerResources();
