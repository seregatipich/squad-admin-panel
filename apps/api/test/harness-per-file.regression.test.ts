// regression: 80 files rebuilt the integration harness in beforeEach — a fresh
// database clone, ~400 registered routes and a DROP DATABASE per test — and
// spent 73% of the api suite's test time on it (518 s of 708 s in CI).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = import.meta.dirname;
const THIS_FILE = path.basename(import.meta.filename);

function testFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name);
    if (statSync(absolute).isDirectory()) return testFiles(absolute);
    return absolute.endsWith('.test.ts') ? [absolute] : [];
  });
}

const HOOK_OR_TEST = /\b(beforeEach|beforeAll|it|test)(?:\.[a-z]+)?\(/g;
const BUILD_CALL = /\bbuildIntegrationApp\(/g;

/**
 * Lines of `buildIntegrationApp(` calls whose nearest preceding hook or test
 * is a `beforeEach` — i.e. harnesses rebuilt for every test. Line-based like
 * the review that found the original 80 files: a call inside a test body or a
 * `beforeAll` is attributed to that block, and a helper function defined above
 * every hook is not attributed to any hook.
 *
 * @param source - A test file's TypeScript source.
 * @returns 1-based line numbers of per-test harness builds.
 */
function perTestHarnessBuilds(source: string): number[] {
  const markers = [...source.matchAll(HOOK_OR_TEST)].map((match) => ({
    index: match.index,
    kind: match[1],
  }));
  const lines: number[] = [];
  for (const call of source.matchAll(BUILD_CALL)) {
    const enclosing = markers.filter((marker) => marker.index < call.index).at(-1);
    if (enclosing?.kind === 'beforeEach') {
      lines.push(source.slice(0, call.index).split('\n').length);
    }
  }
  return lines;
}

describe('integration harness lifetime', () => {
  it('detects a harness rebuilt in beforeEach and ignores beforeAll and test bodies', () => {
    expect(
      perTestHarnessBuilds(
        [
          'beforeEach(async () => {',
          '  h = await buildIntegrationApp({});',
          '});',
          "it('a', async () => {",
          '  const own = await buildIntegrationApp({});',
          '});',
          'beforeAll(async () => {',
          '  h = await buildIntegrationApp({});',
          '});',
        ].join('\n'),
      ),
    ).toEqual([2]);
  });

  it('builds the integration harness once per file, not once per test', () => {
    const offenders = testFiles(TEST_ROOT)
      .filter((file) => path.basename(file) !== THIS_FILE)
      .flatMap((file) =>
        perTestHarnessBuilds(readFileSync(file, 'utf8')).map(
          (line) => `${path.relative(TEST_ROOT, file)}:${line}`,
        ),
      );
    expect(
      offenders,
      'Build the harness in beforeAll and reset only the rows a test depends on; ' +
        'see docs/development/testing.md.',
    ).toEqual([]);
  });
});
