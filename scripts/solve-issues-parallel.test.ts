/**
 * solve-issues-parallel.test.ts — test suite for scripts/solve-issues-parallel.ts.
 *
 * Covers the pure orchestration logic: CLI parsing, branch naming, prompt
 * building, and the concurrency pool. Network-facing code (gh, Claude API)
 * is exercised via `--dry-run` manually and stays out of unit scope.
 *
 * Run: `pnpm exec tsx --test scripts/solve-issues-parallel.test.ts`
 * (wired into the CI `node` job next to the other script test suites).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  branchNameFor,
  buildTaskPrompt,
  type IssueInfo,
  parseCliArgs,
  runPool,
  slugify,
  UsageError,
} from './solve-issues-parallel.ts';

describe('parseCliArgs', () => {
  test('parses issue numbers with defaults', () => {
    const cfg = parseCliArgs(['207', '203']);
    assert.deepEqual(cfg.issues, [207, 203]);
    assert.equal(cfg.concurrency, 3);
    assert.equal(cfg.limit, 5);
    assert.equal(cfg.model, 'claude-opus-4-8');
    assert.equal(cfg.timeoutMin, 45);
    assert.equal(cfg.dryRun, false);
    assert.equal(cfg.verbose, false);
    assert.equal(cfg.label, undefined);
    assert.equal(cfg.repo, undefined);
  });

  test('dedupes repeated issue numbers', () => {
    assert.deepEqual(parseCliArgs(['207', '207', '203']).issues, [207, 203]);
  });

  test('parses all flags', () => {
    const cfg = parseCliArgs([
      '--label',
      'bug',
      '--limit',
      '2',
      '--concurrency',
      '4',
      '--model',
      'claude-sonnet-5',
      '--timeout-min',
      '10',
      '--repo',
      'octo/repo',
      '--dry-run',
      '--verbose',
    ]);
    assert.equal(cfg.label, 'bug');
    assert.equal(cfg.limit, 2);
    assert.equal(cfg.concurrency, 4);
    assert.equal(cfg.model, 'claude-sonnet-5');
    assert.equal(cfg.timeoutMin, 10);
    assert.equal(cfg.repo, 'octo/repo');
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.verbose, true);
  });

  test('requires issue numbers or --label', () => {
    assert.throws(() => parseCliArgs([]), UsageError);
    assert.throws(() => parseCliArgs(['--dry-run']), UsageError);
  });

  test('--help needs no selection', () => {
    assert.equal(parseCliArgs(['--help']).help, true);
  });

  test('skips the pnpm "--" separator', () => {
    const cfg = parseCliArgs(['--', '207', '--dry-run']);
    assert.deepEqual(cfg.issues, [207]);
    assert.equal(cfg.dryRun, true);
  });

  test('rejects unknown options and malformed values', () => {
    assert.throws(() => parseCliArgs(['--bogus']), UsageError);
    assert.throws(() => parseCliArgs(['abc']), UsageError);
    assert.throws(() => parseCliArgs(['-5']), UsageError);
    assert.throws(() => parseCliArgs(['3.5']), UsageError);
    assert.throws(() => parseCliArgs(['--concurrency', '0']), UsageError);
    assert.throws(() => parseCliArgs(['--limit', 'many']), UsageError);
    assert.throws(() => parseCliArgs(['--label']), UsageError);
    assert.throws(() => parseCliArgs(['--label', '--dry-run']), UsageError);
  });
});

describe('slugify / branchNameFor', () => {
  test('lowercases and dash-joins ASCII words', () => {
    assert.equal(slugify('Fix the API 404 Bug!'), 'fix-the-api-404-bug');
  });

  test('truncates on a word boundary at 40 chars', () => {
    const slug = slugify('one two three four five six seven eight nine ten eleven');
    assert.ok(slug.length <= 40, `slug too long: ${slug}`);
    assert.ok(!slug.endsWith('-'));
    assert.equal(slug, 'one-two-three-four-five-six-seven-eight');
  });

  test('returns empty string for titles without ASCII words', () => {
    assert.equal(slugify('Сезоны лидербордов'), '');
  });

  test('branch name falls back to bare issue number for non-ASCII titles', () => {
    assert.equal(branchNameFor({ number: 178, title: 'Сезоны лидербордов' }), 'feature/issue-178');
  });

  test('branch name embeds number and slug', () => {
    assert.equal(
      branchNameFor({ number: 207, title: 'API harness duplicates routes' }),
      'feature/issue-207-api-harness-duplicates-routes',
    );
  });
});

describe('buildTaskPrompt', () => {
  const issue: IssueInfo = {
    number: 207,
    title: 'API integration harness duplicates server.ts route registration',
    body: 'New routes 404 in tests.',
    url: 'https://github.com/octo/repo/issues/207',
  };

  test('contains the issue, branch, mount path, and evidenced handoff rules', () => {
    const prompt = buildTaskPrompt(issue, 'octo/repo', '/workspace/repo');
    assert.ok(prompt.includes('#207'));
    assert.ok(prompt.includes(issue.title));
    assert.ok(prompt.includes(issue.url));
    assert.ok(prompt.includes(issue.body));
    assert.ok(prompt.includes('/workspace/repo'));
    assert.ok(prompt.includes('feature/issue-207-api-integration-harness'));
    assert.ok(prompt.includes('verify-done.sh --feature'));
    assert.ok(prompt.includes('Do NOT merge into `dev`'));
    assert.ok(prompt.includes('Feature-branch handoff evidence — not yet 100% complete'));
    assert.ok(prompt.includes('point-by-point requirement coverage'));
    assert.ok(prompt.includes('runtime/functionality verification'));
    assert.ok(prompt.includes('Re-read the published comment'));
    assert.ok(prompt.includes('handoff-evidence comment URL'));
  });

  test('never embeds credentials', () => {
    const prompt = buildTaskPrompt(issue, 'octo/repo', '/workspace/repo');
    assert.ok(!/token|ghp_|x-access/i.test(prompt));
  });

  test('handles an empty issue body', () => {
    const prompt = buildTaskPrompt({ ...issue, body: '  ' }, 'octo/repo', '/workspace/repo');
    assert.ok(prompt.includes('(no description)'));
  });
});

describe('runPool', () => {
  test('preserves input order in results', async () => {
    const results = await runPool([30, 10, 20], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    assert.deepEqual(results, [60, 20, 40]);
  });

  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 9 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      },
    );
    assert.equal(peak, 3);
  });

  test('handles concurrency larger than the item count and empty input', async () => {
    assert.deepEqual(await runPool([1, 2], 10, async (n) => n + 1), [2, 3]);
    assert.deepEqual(await runPool([], 4, async () => 'never'), []);
  });
});
