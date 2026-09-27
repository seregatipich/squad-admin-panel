import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

/**
 * `next build` skips its own type check and lint (next.config.mjs): the web
 * image build sits on the path of every `dev` deploy, and both checks already
 * run as dedicated gates — `turbo run typecheck` type-checks this package and
 * `biome check` lints it, in the local pre-push checklist and in ci on master.
 *
 * The second case keeps the skip honest. The build's type check also covered
 * `.next/types/validator.ts`, which checks every page's and layout's exports
 * against the route types Next generates; a bare `tsc --noEmit` on a clean
 * checkout has no such file and lets `export default 42` in a page through.
 * `next typegen` writes it first, so the typecheck script still catches that.
 */
describe('next build leaves type checking and linting to the dedicated gates', () => {
  it('skips the build-time type check and lint', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(true);
    expect(nextConfig.eslint?.ignoreDuringBuilds).toBe(true);
  });

  it('type-checks against the generated route types in their place', () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    expect(manifest.scripts.typecheck).toBe('next typegen && tsc --noEmit');
    const tsconfig = JSON.parse(readFileSync(resolve(__dirname, '../tsconfig.json'), 'utf-8'));
    expect(tsconfig.include).toContain('.next/types/**/*.ts');
  });
});
