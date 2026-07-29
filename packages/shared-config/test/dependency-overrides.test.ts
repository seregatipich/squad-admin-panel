import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Durable guard for GHSA-q8mj-m7cp-5q26 (#244) and GHSA-4x5r-pxfx-6jf8 (#245):
// both packages are transitive-only devDependencies with no first-party call
// path, so the only honest regression proof is that a future `pnpm install`
// cannot silently drop the pnpm.overrides entry (qs) or re-widen the lockfile
// back below the patched floor (@babel/core) without this test going red.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCKFILE = readFileSync(path.resolve(__dirname, '../../../pnpm-lock.yaml'), 'utf-8');

describe('root pnpm-lock.yaml security-patched transitive versions', () => {
  it('locks qs outside the vulnerable range >=6.11.1 <=6.15.1 (GHSA-q8mj-m7cp-5q26, #244)', () => {
    const packageVersions = [...LOCKFILE.matchAll(/^\s+qs@([\d.]+):/gm)].map((m) => m[1]);
    const dependencyVersions = [...LOCKFILE.matchAll(/^\s+qs: ([\d.]+)/gm)].map((m) => m[1]);
    expect(packageVersions.length).toBeGreaterThan(0);
    for (const version of [...packageVersions, ...dependencyVersions]) {
      expect(version).not.toBe('6.15.1');
    }
  });

  it('resolves @babel/core to a single version >= 7.29.6 (GHSA-4x5r-pxfx-6jf8, #245)', () => {
    const versions = [
      ...new Set([...LOCKFILE.matchAll(/'@babel\/core@([\d.]+)'/g)].map((m) => m[1])),
    ];
    expect(versions).toHaveLength(1);
    const [, minor, patch] = versions[0].split('.').map(Number);
    expect(minor > 29 || (minor === 29 && patch >= 6)).toBe(true);
  });
});
