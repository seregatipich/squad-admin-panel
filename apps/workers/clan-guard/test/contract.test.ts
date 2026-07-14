import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

// DATABASE_URL/REDIS_URL are intentionally read from the ambient environment
// (never hardcoded here) — see scripts/new-test-db.sh / AGENTS.md local test
// setup. Without a real DATABASE_URL the worker fails to start and this
// contract test times out waiting for the heartbeat key, which is the
// expected local-worktree behavior; the orchestrator runs this against a
// provisioned DB.
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14';
const ENTRY = path.resolve(import.meta.dirname, '../dist/index.js');
const WORKER = 'clan-guard';
const HB_KEY = `worker:heartbeat:${WORKER}`;

let child: ChildProcess | null = null;
let redis: Redis | null = null;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => child?.once('exit', r));
  }
  if (redis) await redis.quit();
  child = null;
  redis = null;
});

describe(`${WORKER} worker contract`, () => {
  it('publishes heartbeat within 30s of start', async () => {
    child = spawn('node', [ENTRY], {
      env: {
        ...process.env,
        REDIS_URL: TEST_REDIS_URL,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.del(HB_KEY);

    for (let i = 0; i < 30; i++) {
      const ttl = await redis.ttl(HB_KEY);
      if (ttl > 0) {
        expect(ttl).toBeLessThanOrEqual(30);
        return;
      }
      await sleep(1000);
    }
    throw new Error(`heartbeat key ${HB_KEY} never appeared`);
  }, 35_000);

  it('exits 0 on SIGTERM within 5s', async () => {
    child = spawn('node', [ENTRY], {
      env: {
        ...process.env,
        REDIS_URL: TEST_REDIS_URL,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await sleep(2000);
    const exitPromise = new Promise<number>((resolve) =>
      child?.once('exit', (code) => resolve(code ?? -1)),
    );
    child.kill('SIGTERM');
    const code = await Promise.race([exitPromise, sleep(5000).then(() => -1 as number)]);
    expect(code).toBe(0);
  }, 10_000);
});
