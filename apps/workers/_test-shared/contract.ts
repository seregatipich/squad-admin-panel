import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '14';
// Use the CI/host-provided redis endpoint — the self-hosted CI runner maps redis
// to a dynamic host port (not 6379), so hardcoding 127.0.0.1:6379 makes the
// spawned worker's connection ECONNREFUSED whenever redis isn't on 6379 (the
// #203 contract-test flake). Derive from TEST_REDIS_URL/REDIS_URL and isolate on
// TEST_REDIS_DB; fall back to the local default for developer machines.
const REDIS_BASE = (
  process.env.TEST_REDIS_URL ??
  process.env.REDIS_URL ??
  'redis://127.0.0.1:6379'
).replace(/\/\d+$/, '');
const REDIS_URL = `${REDIS_BASE}/${TEST_REDIS_DB}`;
// Same reasoning as REDIS_URL, for the other hard requirement: most workers call
// `requiredEnv('DATABASE_URL')` and exit 1 before publishing a heartbeat when
// the runner has no ambient one, which reads as "exited before heartbeat:
// code=1" rather than anything about the database. Supplying it here keeps the
// contract self-contained instead of leaving 15 suites to each remember it.
// Applied before `envOverrides` so a suite can still point at its own database.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;

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

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true }),
      timeoutMs,
    );
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

export function workerContract(opts: ContractOpts) {
  let child: ChildProcess | null = null;
  let redis: RedisContractClient | null = null;
  let stderr = '';

  const spawnWorker = (): ChildProcess => {
    stderr = '';
    const spawned = spawn('node', [opts.entryPath], {
      env: { ...process.env, DATABASE_URL, ...opts.envOverrides, REDIS_URL, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child = spawned;
    return spawned;
  };

  const waitForHeartbeat = async (spawned: ChildProcess): Promise<number> => {
    const deadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isRunning(spawned)) {
        throw new Error(
          `worker ${opts.name} exited before heartbeat: code=${String(spawned.exitCode)} signal=${String(spawned.signalCode)}\n${stderr}`,
        );
      }
      const ttl = await redis?.ttl(opts.expectedHeartbeatKey);
      if (typeof ttl === 'number' && ttl > 0) return ttl;
      await sleep(250);
    }
    throw new Error(`heartbeat key ${opts.expectedHeartbeatKey} never appeared\n${stderr}`);
  };

  afterEach(async () => {
    const c = child;
    if (c && isRunning(c)) {
      const exited = waitForExit(c, SHUTDOWN_TIMEOUT_MS);
      c.kill('SIGTERM');
      const result = await exited;
      if (result.timedOut && isRunning(c)) {
        const killed = waitForExit(c, SHUTDOWN_TIMEOUT_MS);
        c.kill('SIGKILL');
        await killed;
      }
    }
    if (redis) await redis.quit();
    child = null;
    redis = null;
  });

  describe(`${opts.name} worker contract`, () => {
    it('publishes heartbeat within 30s of start', async () => {
      redis = opts.createRedis(REDIS_URL);
      await redis.del(opts.expectedHeartbeatKey);
      const spawned = spawnWorker();
      const ttl = await waitForHeartbeat(spawned);
      expect(ttl).toBeLessThanOrEqual(30);
    }, 35_000);

    it('exits 0 on repeated SIGTERM after publishing readiness', async () => {
      redis = opts.createRedis(REDIS_URL);
      await redis.del(opts.expectedHeartbeatKey);
      const spawned = spawnWorker();
      await waitForHeartbeat(spawned);

      const exited = waitForExit(spawned, SHUTDOWN_TIMEOUT_MS);
      spawned.kill('SIGTERM');
      await sleep(25);
      if (isRunning(spawned)) spawned.kill('SIGTERM');
      const result = await exited;

      expect(result, `worker ${opts.name} did not shut down cleanly\n${stderr}`).toEqual({
        code: 0,
        signal: null,
        timedOut: false,
      });
    }, 45_000);
  });
}
