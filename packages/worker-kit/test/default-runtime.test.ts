import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisInstances: Array<{
  url: string;
  options: {
    maxRetriesPerRequest: null;
    enableReadyCheck: boolean;
    retryStrategy: (times: number) => number;
  };
  handlers: Record<string, (...args: never[]) => void>;
}> = [];
const postgresCalls: Array<{ url: string; options: unknown }> = [];
const drizzleCalls: Array<{ client: unknown; config: unknown }> = [];

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    handlers: Record<string, (...args: never[]) => void> = {};
    constructor(
      readonly url: string,
      readonly options: (typeof redisInstances)[number]['options'],
    ) {
      redisInstances.push(this as unknown as (typeof redisInstances)[number]);
    }
    on(event: string, handler: (...args: never[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    set = vi.fn().mockResolvedValue('OK');
    xadd = vi.fn().mockResolvedValue('1-0');
    quit = vi.fn().mockResolvedValue('OK');
  },
}));
vi.mock('postgres', () => ({
  default: (url: string, options: unknown) => {
    postgresCalls.push({ url, options });
    return { end: vi.fn().mockResolvedValue(undefined) };
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (client: unknown, config: unknown) => {
    drizzleCalls.push({ client, config });
    return { drizzled: true };
  },
}));

import { startWorker } from '../src/index.js';

describe('startWorker default runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    redisInstances.length = 0;
    postgresCalls.length = 0;
    drizzleCalls.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens Redis, Postgres and Drizzle from the process environment', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
    const setup = vi.fn(() => ({ ticks: [] }));
    const signals = new EventEmitter();

    await startWorker(
      {
        name: 'clan-guard',
        log: log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: { drizzle: true },
        setup,
      },
      {
        env: { DATABASE_URL: 'postgres://db/test', REDIS_URL: 'redis://cache/0' },
        exit: vi.fn(),
        signalTarget: signals as never,
      },
    );

    expect(postgresCalls).toEqual([
      { url: 'postgres://db/test', options: { max: 4, prepare: false } },
    ]);
    expect(drizzleCalls).toHaveLength(1);
    expect(drizzleCalls[0]?.config).toHaveProperty('schema');
    const ctx = (setup.mock.calls[0] as unknown[])[0] as { db: unknown };
    expect(ctx.db).toEqual({ drizzled: true });

    const redis = redisInstances[0];
    expect(redis?.url).toBe('redis://cache/0');
    expect(redis?.options.maxRetriesPerRequest).toBeNull();
    expect(redis?.options.enableReadyCheck).toBe(true);
  });

  it('backs Redis reconnects off from 400 ms to a 2 s ceiling', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
    await startWorker(
      {
        name: 'clan-guard',
        log: log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        setup: () => ({ ticks: [] }),
      },
      {
        env: { REDIS_URL: 'redis://cache/0' },
        exit: vi.fn(),
        signalTarget: new EventEmitter() as never,
      },
    );

    const strategy = redisInstances[0]?.options.retryStrategy;
    expect(strategy?.(1)).toBe(400);
    expect(strategy?.(2)).toBe(800);
    expect(strategy?.(3)).toBe(1600);
    expect(strategy?.(4)).toBe(2000);
    expect(strategy?.(50)).toBe(2000);
  });

  it('logs Redis errors and reconnects without throwing', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
    await startWorker(
      {
        name: 'clan-guard',
        log: log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        setup: () => ({ ticks: [] }),
      },
      {
        env: { REDIS_URL: 'redis://cache/0' },
        exit: vi.fn(),
        signalTarget: new EventEmitter() as never,
      },
    );

    const handlers = redisInstances[0]?.handlers ?? {};
    (handlers.error as (err: Error) => void)(new Error('ECONNREFUSED'));
    (handlers.reconnecting as (delay: number) => void)(400);

    expect(log.warn).toHaveBeenCalledWith({ err: 'ECONNREFUSED' }, 'redis error (will retry)');
    expect(log.info).toHaveBeenCalledWith({ delay: 400 }, 'redis reconnecting');
  });
});
