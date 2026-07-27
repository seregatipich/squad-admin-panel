import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

// Derive the redis endpoint the way apps/workers/_test-shared/contract.ts does.
// CI maps redis to a dynamic host port, so a hardcoded 127.0.0.1:6379 makes the
// spawned worker ECONNREFUSED there while passing on a developer machine that
// happens to run redis on the default port (the #203 contract-test flake).
const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '14';
const TEST_REDIS_BASE = (
  process.env.TEST_REDIS_URL ??
  process.env.REDIS_URL ??
  'redis://127.0.0.1:6379'
).replace(/\/\d+$/, '');
const TEST_REDIS_URL = `${TEST_REDIS_BASE}/${TEST_REDIS_DB}`;
const ENTRY = path.resolve(import.meta.dirname, '../dist/index.js');
const WORKER = 'discord';
const HB_KEY = `worker:heartbeat:${WORKER}`;

let child: ChildProcess | null = null;
let redis: Redis | null = null;

afterEach(async () => {
  if (child && !child.killed) {
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
      env: { ...process.env, REDIS_URL: TEST_REDIS_URL, NODE_ENV: 'test' },
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
      env: { ...process.env, REDIS_URL: TEST_REDIS_URL, NODE_ENV: 'test' },
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
