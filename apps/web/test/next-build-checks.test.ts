import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

/**
 * `next build` skips its own type check and lint (next.config.mjs): the web
 * image build sits on the path of every `dev` deploy, and both checks already
 * run as dedicated gates — `turbo run typecheck` runs this package's
 * `tsc --noEmit` and `biome check` lints it, in the local pre-push checklist
 * and in ci on master. The second case keeps the skip honest: without the
 * typecheck script nothing would type-check the web app any more.
 */
describe('next build leaves type checking and linting to the dedicated gates', () => {
  it('skips the build-time type check and lint', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(true);
    expect(nextConfig.eslint?.ignoreDuringBuilds).toBe(true);
  });

  it('keeps tsc --noEmit as the typecheck that replaces them', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    expect(manifest.scripts.typecheck).toBe('tsc --noEmit');
  });
});
