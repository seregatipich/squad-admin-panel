import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for the worker vitest setup files (#120): load-env.ts and
 * redis-per-worker.ts must not invent a Redis. With REDIS_URL unset both leave
 * it unset, so `describeIfRedis` skips the suite locally and refuses to skip it
 * under CI; with REDIS_URL set the suite keeps its own Redis logical database
 * per worker slot.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/** Runs the two setup files in a fresh process and returns the Redis variables they leave. */
function runSetupFiles(env: Record<string, string>): Record<string, string | null> {
  const shared = resolve(REPO_ROOT, 'apps/workers/_test-shared');
  const dir = mkdtempSync(join(tmpdir(), 'worker-redis-env-'));
  const script = join(dir, 'probe.mts');
  writeFileSync(
    script,
    [
      `await import(${JSON.stringify(join(shared, 'load-env.ts'))});`,
      `await import(${JSON.stringify(join(shared, 'redis-per-worker.ts'))});`,
      'console.log(JSON.stringify({',
      '  REDIS_URL: process.env.REDIS_URL ?? null,',
      '  TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? null,',
      '  TEST_REDIS_DB: process.env.TEST_REDIS_DB ?? null,',
      '}));',
    ].join('\n'),
  );
  try {
    const result = spawnSync(TSX, [script], {
      cwd: REPO_ROOT,
      // A clean environment: only PATH plus what the case sets, so the caller's own REDIS_URL cannot leak in.
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('worker test setup files — Redis environment', () => {
  it('leaves REDIS_URL unset when no Redis is configured, so describeIfRedis can skip', () => {
    expect(runSetupFiles({})).toEqual({
      REDIS_URL: null,
      TEST_REDIS_URL: null,
      TEST_REDIS_DB: null,
    });
  });

  it('leaves REDIS_URL unset under CI too, so the gate fails the run instead of connecting to a made-up server', () => {
    expect(runSetupFiles({ CI: 'true' }).REDIS_URL).toBeNull();
  });

  it('gives a configured Redis the logical database of the Vitest worker slot', () => {
    expect(
      runSetupFiles({ REDIS_URL: 'redis://:secret@10.0.0.5:6380/0', VITEST_POOL_ID: '3' }),
    ).toEqual({
      REDIS_URL: 'redis://:secret@10.0.0.5:6380/3',
      TEST_REDIS_URL: 'redis://:secret@10.0.0.5:6380/3',
      TEST_REDIS_DB: '3',
    });
  });

  it('wraps slots beyond the seven worker databases and keeps a URL without a database', () => {
    expect(
      runSetupFiles({ REDIS_URL: 'redis://127.0.0.1:6379', VITEST_POOL_ID: '9' }),
    ).toMatchObject({
      REDIS_URL: 'redis://127.0.0.1:6379/2',
      TEST_REDIS_DB: '2',
    });
  });

  it('prefers TEST_REDIS_URL as the base, as the contract harness does', () => {
    expect(
      runSetupFiles({
        REDIS_URL: 'redis://127.0.0.1:6379/0',
        TEST_REDIS_URL: 'redis://127.0.0.1:6400/15',
        VITEST_POOL_ID: '1',
      }),
    ).toMatchObject({
      REDIS_URL: 'redis://127.0.0.1:6400/1',
      TEST_REDIS_URL: 'redis://127.0.0.1:6400/1',
    });
  });
});
