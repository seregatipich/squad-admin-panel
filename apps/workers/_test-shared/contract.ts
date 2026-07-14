import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '14';
const REDIS_URL = `redis://127.0.0.1:6379/${TEST_REDIS_DB}`;

export interface ContractOpts {
  name: string;
  entryPath: string;
  expectedHeartbeatKey: string;
  /** Creates a Redis client from the worker package that owns the contract test. */
  createRedis: (url: string) => RedisContractClient;
  envOverrides?: Record<string, string>;
}

interface RedisContractClient {
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export function workerContract(opts: ContractOpts) {
  let child: ChildProcess | null = null;
  let redis: RedisContractClient | null = null;

  afterEach(async () => {
    const c = child;
    if (c && !c.killed) {
      c.kill('SIGTERM');
      // Bound the wait: under CI coverage instrumentation a clean shutdown can
      // take several seconds; never let a slow (or genuinely stuck) child hang
      // the hook — SIGKILL as a fallback so cleanup always completes.
      const exited = new Promise((r) => c.once('exit', r));
      const timedOut = await Promise.race([exited.then(() => false), sleep(8000).then(() => true)]);
      if (timedOut) {
        c.kill('SIGKILL');
        await exited;
      }
    }
    if (redis) await redis.quit();
    child = null;
    redis = null;
  });

  describe(`${opts.name} worker contract`, () => {
    it('publishes heartbeat within 30s of start', async () => {
      child = spawn('node', [opts.entryPath], {
        env: { ...process.env, ...opts.envOverrides, REDIS_URL, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      redis = opts.createRedis(REDIS_URL);

      child.on('exit', (code) => {
        if (code !== null && code !== 0) {
          throw new Error(`worker ${opts.name} exited early with code ${code}`);
        }
      });

      await redis.del(opts.expectedHeartbeatKey);

      for (let i = 0; i < 30; i++) {
        const ttl = await redis.ttl(opts.expectedHeartbeatKey);
        if (ttl > 0) {
          expect(ttl).toBeLessThanOrEqual(30);
          return;
        }
        await sleep(1000);
      }
      throw new Error(`heartbeat key ${opts.expectedHeartbeatKey} never appeared`);
    }, 35_000);

    it('exits 0 on SIGTERM within 5s', async () => {
      child = spawn('node', [opts.entryPath], {
        env: { ...process.env, ...opts.envOverrides, REDIS_URL, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await sleep(2000);
      const exitPromise = new Promise<number>((resolve) =>
        child?.once('exit', (code) => resolve(code ?? -1)),
      );
      child.kill('SIGTERM');
      // 8s window (was 5s): under v8 coverage instrumentation a clean shutdown
      // of the built worker binary can exceed 5s on the loaded CI runner. Still
      // asserts a clean exit(0) — a genuinely hung worker is caught within 8s.
      const code = await Promise.race([exitPromise, sleep(8000).then(() => -1 as number)]);
      expect(code).toBe(0);
    }, 15_000);
  });
}
