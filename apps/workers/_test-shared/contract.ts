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
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => child?.once('exit', r));
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
      const code = await Promise.race([exitPromise, sleep(5000).then(() => -1 as number)]);
      expect(code).toBe(0);
    }, 10_000);
  });
}
