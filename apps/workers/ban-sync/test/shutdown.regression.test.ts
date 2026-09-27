// Regression: SIGTERM used to wait out the manual-queue XREADGROUP, which
// blocks for up to 5 s — and because that read shared the worker's only Redis
// connection, even the shutdown diag event queued behind it. Every stop of the
// worker (and every contract test) therefore took up to five extra seconds.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY_PATH = path.resolve(import.meta.dirname, '../dist/index.js');
const HEARTBEAT_KEY = 'worker:heartbeat:ban-sync';
const MANUAL_STREAM = 'bansync:manual';
const MANUAL_GROUP = 'ban-sync';
// Far below the 5 s the manual-queue read blocks for, far above the few
// hundred milliseconds closing the worker's connections takes.
const PROMPT_EXIT_MS = 2_000;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;
// `redis-per-worker.ts` points REDIS_URL at this worker slot's own database, so
// the worker `contract.test.ts` spawns never reads this file's stream.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

let child: ChildProcess | null = null;
let redis: Redis | null = null;

function isRunning(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function waitFor(what: string, proc: ChildProcess, check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isRunning(proc)) throw new Error(`worker exited while waiting for ${what}`);
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** XINFO GROUPS returns one flat `[field, value, …]` array per group. */
async function manualGroup(client: Redis): Promise<Map<string, unknown> | null> {
  const groups = (await client.xinfo('GROUPS', MANUAL_STREAM).catch(() => [])) as unknown[][];
  for (const flat of groups) {
    const fields = new Map<string, unknown>();
    for (let i = 0; i < flat.length; i += 2) fields.set(String(flat[i]), flat[i + 1]);
    if (fields.get('name') === MANUAL_GROUP) return fields;
  }
  return null;
}

afterEach(async () => {
  if (child && isRunning(child)) child.kill('SIGKILL');
  child = null;
  if (redis) {
    await redis.del(HEARTBEAT_KEY, MANUAL_STREAM);
    await redis.quit();
  }
  redis = null;
});

describe('ban-sync shutdown', () => {
  it('interrupts the blocking manual-queue read instead of waiting it out', async () => {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    redis = client;
    await client.del(HEARTBEAT_KEY, MANUAL_STREAM);

    const worker = spawn('node', [ENTRY_PATH], {
      env: {
        ...process.env,
        DATABASE_URL,
        REDIS_URL,
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = worker;
    let stderr = '';
    worker.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    const exited = new Promise<Exit>((resolve) => {
      worker.once('exit', (code, signal) => resolve({ code, signal }));
    });

    await waitFor('the heartbeat', worker, async () => (await client.ttl(HEARTBEAT_KEY)) > 0);
    await waitFor(
      'the manual-queue group',
      worker,
      async () => (await manualGroup(client)) !== null,
    );

    // A job for a source that does not exist is read, logged and acknowledged;
    // the loop then starts a fresh blocking read, so SIGTERM lands at the start
    // of a full block rather than at a random point inside one.
    const entryId = await client.xadd(
      MANUAL_STREAM,
      '*',
      'job',
      JSON.stringify({ source_id: randomUUID(), request_id: randomUUID() }),
    );
    await waitFor('the manual job to be acknowledged', worker, async () => {
      const group = await manualGroup(client);
      return group?.get('last-delivered-id') === entryId && group?.get('pending') === 0;
    });
    await sleep(100);

    const signalledAt = Date.now();
    worker.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      sleep(8_000).then(() => ({ code: null, signal: null }) as Exit),
    ]);
    const elapsed = Date.now() - signalledAt;

    expect(result, `worker did not shut down cleanly\n${stderr}`).toEqual({
      code: 0,
      signal: null,
    });
    expect(elapsed, `SIGTERM took ${elapsed} ms\n${stderr}`).toBeLessThan(PROMPT_EXIT_MS);
  }, 45_000);
});
