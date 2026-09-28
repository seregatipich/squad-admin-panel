/**
 * solve-issues-parallel.test.ts — test suite for scripts/solve-issues-parallel.ts.
 *
 * Covers the pure orchestration logic: CLI parsing, branch naming, prompt
 * building, the concurrency pool, and how `solveIssue` classifies a session's
 * event stream (against a stand-in client). The live gh and Claude API calls
 * are exercised via `--dry-run` manually and stay out of unit scope.
 *
 * Run: `pnpm exec tsx --test scripts/solve-issues-parallel.test.ts`
 * (wired into the CI `node` job next to the other script test suites).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  branchNameFor,
  buildTaskPrompt,
  type IssueInfo,
  parseCliArgs,
  runPool,
  type SessionContext,
  slugify,
  solveIssue,
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

describe('solveIssue session outcome', () => {
  const issue: IssueInfo = { number: 7, title: 'Fix the thing', body: '', url: 'u' };

  /** A stand-in client whose event stream yields `events`, then ends. */
  function contextStreaming(events: readonly Record<string, unknown>[]): SessionContext {
    const client = {
      beta: {
        sessions: {
          create: async () => ({ id: 'sesn_test' }),
          events: {
            stream: async () =>
              (async function* () {
                yield* events;
              })(),
            send: async () => ({}),
          },
        },
      },
    } as unknown as Anthropic;
    return {
      client,
      agentId: 'agent',
      environmentId: 'env',
      repoSlug: 'owner/repo',
      githubToken: 'unused',
      model: 'model',
      timeoutMin: 1,
      verbose: false,
    };
  }

  const message = (text: string) => ({ type: 'agent.message', content: [{ type: 'text', text }] });
  const idle = (stopReason: Record<string, unknown>) => ({
    type: 'session.status_idle',
    stop_reason: stopReason,
  });
  const sessionError = (retryStatus: string) => ({
    type: 'session.error',
    error: {
      type: 'model_overloaded_error',
      message: 'overloaded',
      retry_status: { type: retryStatus },
    },
  });

  test('an idle session that ended its turn is solved', async () => {
    const result = await solveIssue(
      contextStreaming([message('done'), idle({ type: 'end_turn' })]),
      issue,
    );
    assert.equal(result.status, 'solved');
    assert.equal(result.summary, 'done');
  });

  test('an idle session that exhausted its retries is a failure, not a success', async () => {
    const result = await solveIssue(
      contextStreaming([message('partial'), idle({ type: 'retries_exhausted' })]),
      issue,
    );
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /retries_exhausted/);
    assert.match(result.summary, /partial/);
  });

  test('an idle session waiting on a tool confirmation is a failure', async () => {
    const result = await solveIssue(
      contextStreaming([idle({ type: 'requires_action', event_ids: ['sevt_1'] })]),
      issue,
    );
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /requires_action/);
  });

  test('keeps reading through an error the server is still retrying', async () => {
    const result = await solveIssue(
      contextStreaming([
        sessionError('retrying'),
        message('recovered'),
        idle({ type: 'end_turn' }),
      ]),
      issue,
    );
    assert.equal(result.status, 'solved');
    assert.equal(result.summary, 'recovered');
  });

  test('stops on an exhausted or terminal error', async () => {
    for (const retryStatus of ['exhausted', 'terminal']) {
      const result = await solveIssue(
        contextStreaming([sessionError(retryStatus), idle({ type: 'end_turn' })]),
        issue,
      );
      assert.equal(result.status, 'failed', retryStatus);
      assert.match(result.summary, /session error/, retryStatus);
    }
  });
});
