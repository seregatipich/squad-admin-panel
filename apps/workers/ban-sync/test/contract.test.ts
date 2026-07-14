import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_REDIS_URL = 'redis://127.0.0.1:6379/14';
const ENTRY = path.resolve(import.meta.dirname, '../dist/index.js');
const WORKER = 'ban-sync';
const HB_KEY = `worker:heartbeat:${WORKER}`;
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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

// The heartbeat is published before any DB-dependent work runs (see
// apps/workers/ban-sync/src/index.ts), so this contract holds regardless of
// whether DATABASE_URL is actually reachable/authenticated in this
// environment — `tick()` swallows its own errors and never blocks startup.
describe(`${WORKER} worker contract`, () => {
  it('publishes heartbeat within 30s of start', async () => {
    child = spawn('node', [ENTRY], {
      env: {
        ...process.env,
        REDIS_URL: TEST_REDIS_URL,
        DATABASE_URL: 'postgres://admin:placeholder@127.0.0.1:5432/admin',
        APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
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
        DATABASE_URL: 'postgres://admin:placeholder@127.0.0.1:5432/admin',
        APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
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
