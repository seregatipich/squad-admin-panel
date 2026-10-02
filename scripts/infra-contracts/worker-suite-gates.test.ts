import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract: a worker or package test file that opens its own Postgres or Redis
 * connection declares itself with `describeIfDb` / `describeIfRedis` /
 * `describeIfDbAndRedis` from packages/db/test/helpers/describe-if.ts.
 *
 * An ungated suite fails hard on a machine without the services instead of
 * being reported as skipped, and under `CI` a gate turns a missing service into
 * an error, which an ungated suite never does (#120).
 *
 * Not covered, on purpose: `contract.test.ts` files, whose shared harness
 * (apps/workers/_test-shared/contract.ts) spawns the built worker and gates its
 * suite itself with `describeIfRedis`; `global-setup.ts` and the helper directories, which
 * are not suites; and apps/api, whose harness has its own gating rules.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const OWN_CONNECTION = /new (?:Redis|IORedis)\(|createDatabaseClient\(|\bpostgres\(/;
const GATE_IMPORT = /describe-if(?:\.js)?['"]/;

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'helpers') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.ts$/.test(entry) && entry !== 'contract.test.ts') found.push(path);
  }
  return found;
}

function testDirectories(): string[] {
  const roots = ['apps/workers', 'packages'];
  const dirs: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(join(REPO_ROOT, root))) {
      const dir = join(REPO_ROOT, root, name, 'test');
      try {
        if (statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        // the package has no test directory
      }
    }
  }
  return dirs;
}

/** Test files that open a connection of their own, as repository-relative paths. */
function ungatedSuites(): string[] {
  return testDirectories()
    .flatMap(testFiles)
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return OWN_CONNECTION.test(source) && !GATE_IMPORT.test(source);
    })
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

describe('worker and package suites that connect to Postgres or Redis', () => {
  it('scans the test directories it is meant to cover', () => {
    const scanned = testDirectories().map((dir) => relative(REPO_ROOT, dir));
    expect(scanned).toContain('apps/workers/log-ingest/test');
    expect(scanned).toContain('packages/db/test');
  });

  it('are all declared through a describeIfDb / describeIfRedis gate', () => {
    expect(ungatedSuites()).toEqual([]);
  });
});
