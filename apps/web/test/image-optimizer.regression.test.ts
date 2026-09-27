import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

/**
 * Regression for #22: the web image shipped next@15.5.22 and sharp@0.35.3,
 * both below the releases that fix published advisories in the image
 * optimizer (GHSA-2xp9-vwfh-vxw4, fixed in next 15.5.24) and in sharp's
 * bundled libheif (GHSA-rgj7-g3m4-5g8c, fixed in sharp 0.35.4).
 *
 * The panel renders no `next/image`, so the optimizer endpoint is also
 * switched off entirely rather than left reachable by default.
 */

/**
 * Version of `pkg` as Node resolves it from the module `fromFile`.
 *
 * Walks up from the resolved entry point instead of requiring
 * `<pkg>/package.json`, because sharp's `exports` map does not expose it.
 */
function resolvedVersion(pkg: string, fromFile: string): string {
  let dir = dirname(createRequire(fromFile).resolve(pkg));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (manifest.name === pkg) return manifest.version as string;
    } catch {
      // No manifest at this level; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json found for ${pkg}`);
    dir = parent;
  }
}

function atLeast(version: string, minimum: string): boolean {
  const actual = version.split('.').map(Number);
  const floor = minimum.split('.').map(Number);
  for (let i = 0; i < floor.length; i++) {
    const a = actual[i] ?? 0;
    const f = floor[i] ?? 0;
    if (a !== f) return a > f;
  }
  return true;
}

const webManifest = join(__dirname, '..', 'package.json');

describe('web image dependencies carry the advisory fixes (#22)', () => {
  it('resolves next at or above 15.5.24', () => {
    const version = resolvedVersion('next', webManifest);
    expect(atLeast(version, '15.5.24'), `next@${version}`).toBe(true);
  });

  it('resolves the sharp next loads at or above 0.35.4', () => {
    const nextEntry = createRequire(webManifest).resolve('next');
    const version = resolvedVersion('sharp', nextEntry);
    expect(atLeast(version, '0.35.4'), `sharp@${version}`).toBe(true);
  });

  it('disables the unused image optimizer', () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});
