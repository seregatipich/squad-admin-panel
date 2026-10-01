import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { DatabaseClient } from '@squad/db';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runWorker,
  startWorker,
  type TickJob,
  type WorkerPlan,
  type WorkerRuntime,
  type WorkerSpec,
} from '../src/index.js';

const SECOND = 1_000;

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  };
}

function makeHarness(events: string[] = []) {
  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    xadd: vi.fn().mockResolvedValue('1-0'),
    quit: vi.fn(async () => {
      events.push('redis.quit');
      return 'OK';
    }),
  };
  const sql = {
    end: vi.fn(async () => {
      events.push('sql.end');
    }),
  };
  const db = { fake: 'db' };
  const signals = new EventEmitter();
  const exit = vi.fn();
  const createPostgres = vi.fn((_url: string, _options: unknown) => sql);
  const createRedis = vi.fn((_url: string, _log: unknown) => redis);
  const createDatabase = vi.fn((_sql: unknown) => db);
  const log = makeLog();
  const runtime = {
    env: { DATABASE_URL: 'postgres://db/test', REDIS_URL: 'redis://cache/0' },
    exit,
    createRedis,
    createPostgres,
    createDatabase,
    signalTarget: signals as unknown as WorkerRuntime['signalTarget'],
  } as unknown as Partial<WorkerRuntime> & { env: NodeJS.ProcessEnv };

  const diagKinds = (): string[] =>
    redis.xadd.mock.calls.map((call) => {
      const args = call as unknown[];
      return String(args[args.indexOf('kind') + 1]);
    });
  const diagField = (index: number, field: string): string => {
    const args = redis.xadd.mock.calls[index] as unknown[];
    return String(args[args.indexOf(field) + 1]);
  };
  const heartbeatKeys = (): string[] => redis.set.mock.calls.map((call) => String(call[0]));

  return {
    redis,
    sql,
    db,
    signals,
    exit,
    createPostgres,
    createRedis,
    createDatabase,
    log,
    runtime,
    diagKinds,
    diagField,
    heartbeatKeys,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeSpec(
  harness: Harness,
  plan: WorkerPlan,
  overrides: Record<string, unknown> = {},
): WorkerSpec {
  return {
    name: 'role-expirer',
    log: harness.log as unknown as Logger,
    entrypoint: 'file:///unused.js',
    setup: () => plan,
    ...overrides,
  };
}

const tickJob = (overrides: Partial<TickJob> = {}): TickJob => ({
  intervalMs: 10 * SECOND,
  run: vi.fn().mockResolvedValue(undefined),
  failureMessage: 'tick failed',
  ...overrides,
});

/** Lets pending promise chains settle without moving fake time forward. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('startWorker resources', () => {
  it('opens Postgres with the default options and passes sql, db, redis and diag to setup', async () => {
    const h = makeHarness();
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);
    await startWorker(
      {
        name: 'clan-guard',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: { drizzle: true },
        setup,
      },
      h.runtime,
    );

    expect(h.createPostgres).toHaveBeenCalledWith('postgres://db/test', {
      max: 4,
      prepare: false,
    });
    expect(h.createRedis).toHaveBeenCalledWith('redis://cache/0', h.log);
    expect(h.createDatabase).toHaveBeenCalledWith(h.sql);
    const ctx = (setup.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(ctx.name).toBe('clan-guard');
    expect(ctx.sql).toBe(h.sql);
    expect(ctx.db).toBe(h.db);
    expect(ctx.redis).toBe(h.redis);
    expect(ctx.log).toBe(h.log);
    expect(typeof (ctx.diag as { emit: unknown }).emit).toBe('function');
  });

  it('forwards custom Postgres options and builds no Drizzle client unless asked', async () => {
    const h = makeHarness();
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);
    await startWorker(
      {
        name: 'stats',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: { options: { max: 1 } },
        setup,
      },
      h.runtime,
    );

    expect(h.createPostgres).toHaveBeenCalledWith('postgres://db/test', { max: 1 });
    expect(h.createDatabase).not.toHaveBeenCalled();
    expect(((setup.mock.calls[0] as unknown[])[0] as { db: unknown }).db).toBeNull();
  });

  it('gives setup a null pool when the worker declares no Postgres', async () => {
    const h = makeHarness();
    h.runtime.env = { REDIS_URL: 'redis://cache/0' };
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);
    await startWorker(
      {
        name: 'audit-archiver',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        setup,
      },
      h.runtime,
    );

    expect(h.createPostgres).not.toHaveBeenCalled();
    expect(((setup.mock.calls[0] as unknown[])[0] as { sql: unknown }).sql).toBeNull();
  });

  it('logs fatal and exits 1 when a required DATABASE_URL is missing', async () => {
    const h = makeHarness();
    h.runtime.env = { REDIS_URL: 'redis://cache/0' };
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);

    await expect(
      startWorker(
        {
          name: 'clan-guard',
          log: h.log as unknown as Logger,
          entrypoint: 'file:///unused.js',
          postgres: { drizzle: true },
          setup,
        },
        h.runtime,
      ),
    ).rejects.toThrow('DATABASE_URL is required');

    expect(h.log.fatal).toHaveBeenCalledWith('DATABASE_URL is required');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.createRedis).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it('treats an empty DATABASE_URL as missing', async () => {
    const h = makeHarness();
    h.runtime.env = { DATABASE_URL: '', REDIS_URL: 'redis://cache/0' };

    await expect(
      startWorker(
        {
          name: 'clan-guard',
          log: h.log as unknown as Logger,
          entrypoint: 'file:///unused.js',
          postgres: {},
          setup: () => ({ ticks: [] }),
        },
        h.runtime,
      ),
    ).rejects.toThrow('DATABASE_URL is required');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('logs fatal and exits 1 when a required REDIS_URL is missing', async () => {
    const h = makeHarness();
    h.runtime.env = { DATABASE_URL: 'postgres://db/test' };

    await expect(
      startWorker(
        {
          name: 'clan-guard',
          log: h.log as unknown as Logger,
          entrypoint: 'file:///unused.js',
          postgres: {},
          setup: () => ({ ticks: [] }),
        },
        h.runtime,
      ),
    ).rejects.toThrow('REDIS_URL is required');

    expect(h.log.fatal).toHaveBeenCalledWith('REDIS_URL is required');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('runs without a pool when optional Postgres has no URL', async () => {
    const h = makeHarness();
    h.runtime.env = { REDIS_URL: 'redis://cache/0' };
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);

    await startWorker(
      {
        name: 'stats',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: { optional: true, drizzle: true },
        setup,
      },
      h.runtime,
    );

    const ctx = (setup.mock.calls[0] as unknown[])[0] as { sql: unknown; db: unknown };
    expect(ctx.sql).toBeNull();
    expect(ctx.db).toBeNull();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('runs without Redis when it is optional and unset: no heartbeat, no diag traffic', async () => {
    const h = makeHarness();
    h.runtime.env = { DATABASE_URL: 'postgres://db/test' };
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);

    await startWorker(
      {
        name: 'presence-daily',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: {},
        redis: { optional: true },
        setup,
      },
      h.runtime,
    );
    await vi.advanceTimersByTimeAsync(30 * SECOND);

    expect(h.createRedis).not.toHaveBeenCalled();
    expect(h.redis.set).not.toHaveBeenCalled();
    expect(h.redis.xadd).not.toHaveBeenCalled();
    expect(((setup.mock.calls[0] as unknown[])[0] as { redis: unknown }).redis).toBeNull();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('shuts down cleanly when Redis is optional and unset', async () => {
    const h = makeHarness();
    h.runtime.env = { DATABASE_URL: 'postgres://db/test' };
    await startWorker(
      {
        name: 'presence-daily',
        log: h.log as unknown as Logger,
        entrypoint: 'file:///unused.js',
        postgres: {},
        redis: { optional: true },
        setup: () => ({ ticks: [tickJob()] }),
      },
      h.runtime,
    );

    h.signals.emit('SIGTERM');
    await settle();

    expect(h.sql.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('startWorker heartbeat and lifecycle diag', () => {
  it('publishes worker:heartbeat:<name> with the default status', async () => {
    const h = makeHarness();
    await startWorker(makeSpec(h, { ticks: [] }), h.runtime);
    await settle();

    expect(h.heartbeatKeys()).toEqual(['worker:heartbeat:role-expirer']);
    const payload = JSON.parse(String((h.redis.set.mock.calls[0] as unknown[])[1]));
    expect(payload).toMatchObject({ name: 'role-expirer', status: 'running', pid: process.pid });
    expect((h.redis.set.mock.calls[0] as unknown[]).slice(2)).toEqual(['EX', 30]);
  });

  it('publishes a static or computed heartbeat status', async () => {
    const h = makeHarness();
    let status = 'idle';
    await startWorker(makeSpec(h, { ticks: [] }, { heartbeatStatus: () => status }), h.runtime);
    await settle();
    status = 'degraded';
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    const statuses = h.redis.set.mock.calls.map(
      (call) => JSON.parse(String((call as unknown[])[1])).status,
    );
    expect(statuses).toEqual(['idle', 'degraded']);

    const h2 = makeHarness();
    await startWorker(
      makeSpec(h2, { ticks: [] }, { heartbeatStatus: 'archiving off' }),
      h2.runtime,
    );
    await settle();
    expect(JSON.parse(String((h2.redis.set.mock.calls[0] as unknown[])[1])).status).toBe(
      'archiving off',
    );
  });

  it('logs a failed heartbeat publish instead of crashing', async () => {
    const h = makeHarness();
    h.redis.set.mockRejectedValue(new Error('redis down'));
    await startWorker(makeSpec(h, { ticks: [] }), h.runtime);
    await settle();

    expect(h.log.warn).toHaveBeenCalledWith({ err: 'redis down' }, 'heartbeat publish failed');
  });

  it('emits <snake_name>.started with the pid payload', async () => {
    const h = makeHarness();
    await startWorker(makeSpec(h, { ticks: [] }), h.runtime);

    expect(h.diagKinds()).toEqual(['role_expirer.started']);
    expect(h.diagField(0, 'component')).toBe('worker-role-expirer');
    expect(h.diagField(0, 'severity')).toBe('info');
    expect(h.diagField(0, 'message')).toBe('role-expirer started');
    expect(JSON.parse(h.diagField(0, 'payload'))).toEqual({ pid: process.pid });
  });

  it('uses a custom started payload', async () => {
    const h = makeHarness();
    await startWorker(
      makeSpec(h, { ticks: [], startedPayload: { intervalMs: 60_000, configured: true } }),
      h.runtime,
    );

    expect(JSON.parse(h.diagField(0, 'payload'))).toEqual({ intervalMs: 60_000, configured: true });
  });

  it('skips the started and stopped events when lifecycleDiag is off', async () => {
    const h = makeHarness();
    await startWorker(makeSpec(h, { ticks: [] }, { lifecycleDiag: false }), h.runtime);
    h.signals.emit('SIGTERM');
    await settle();

    expect(h.redis.xadd).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('startWorker passes', () => {
  it('runs beforeFirstTick after the started event and before the first pass', async () => {
    const h = makeHarness();
    const order: string[] = [];
    h.redis.xadd.mockImplementation(async () => {
      order.push('diag');
      return '1-0';
    });
    await startWorker(
      makeSpec(h, {
        ticks: [
          tickJob({
            run: async () => {
              order.push('tick');
            },
          }),
        ],
        beforeFirstTick: async () => {
          order.push('before');
        },
      }),
      h.runtime,
    );

    expect(order).toEqual(['diag', 'before', 'tick']);
  });

  it('runs every pass once in order at startup, then on each interval', async () => {
    const h = makeHarness();
    const order: string[] = [];
    const fast = tickJob({
      intervalMs: 10 * SECOND,
      run: async () => {
        order.push('fast');
      },
    });
    const slow = tickJob({
      intervalMs: 25 * SECOND,
      run: async () => {
        order.push('slow');
      },
    });
    await startWorker(makeSpec(h, { ticks: [fast, slow] }), h.runtime);
    expect(order).toEqual(['fast', 'slow']);

    await vi.advanceTimersByTimeAsync(30 * SECOND);

    expect(order.filter((entry) => entry === 'fast')).toHaveLength(1 + 3);
    expect(order.filter((entry) => entry === 'slow')).toHaveLength(1 + 1);
  });

  it('aborts startup when a fatal first pass rejects and arms no interval', async () => {
    const h = makeHarness();
    const run = vi.fn().mockRejectedValue(new Error('first pass broke'));

    await expect(
      startWorker(makeSpec(h, { ticks: [tickJob({ run })] }), h.runtime),
    ).rejects.toThrow('first pass broke');
    await vi.advanceTimersByTimeAsync(60 * SECOND);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs and carries on when a first pass marked firstRunFailure log rejects', async () => {
    const h = makeHarness();
    const failing = vi.fn().mockRejectedValue(new Error('upstream outage'));
    const next = vi.fn().mockResolvedValue(undefined);

    await startWorker(
      makeSpec(h, {
        ticks: [
          tickJob({ run: failing, failureMessage: 'refresh failed', firstRunFailure: 'log' }),
          tickJob({ run: next }),
        ],
      }),
      h.runtime,
    );

    expect(h.log.error).toHaveBeenCalledWith({ err: 'upstream outage' }, 'refresh failed');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('logs an interval pass failure with the pass failureMessage and keeps ticking', async () => {
    const h = makeHarness();
    const run = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    await startWorker(
      makeSpec(h, { ticks: [tickJob({ run, failureMessage: 'role-expirer tick failed' })] }),
      h.runtime,
    );

    await vi.advanceTimersByTimeAsync(20 * SECOND);

    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith({ err: 'transient' }, 'role-expirer tick failed');
    expect(run).toHaveBeenCalledTimes(3);
  });

  describe('overlap handling', () => {
    function slowTick(overlap: TickJob['overlap']) {
      let release: (() => void) | undefined;
      let concurrent = 0;
      let maxConcurrent = 0;
      let calls = 0;
      const job = tickJob({
        overlap,
        run: async () => {
          calls += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          // Only the pass started by the interval hangs; the startup pass returns.
          if (calls > 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          concurrent -= 1;
        },
      });
      return {
        job,
        release: () => release?.(),
        stats: () => ({ calls, maxConcurrent }),
      };
    }

    it('skips an overlapping call silently by default', async () => {
      const h = makeHarness();
      const tick = slowTick(undefined);
      await startWorker(makeSpec(h, { ticks: [tick.job] }), h.runtime);

      await vi.advanceTimersByTimeAsync(10 * SECOND);
      await vi.advanceTimersByTimeAsync(10 * SECOND);

      expect(tick.stats()).toEqual({ calls: 2, maxConcurrent: 1 });
      expect(h.log.warn).not.toHaveBeenCalled();
      tick.release();
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(tick.stats().calls).toBe(3);
    });

    it('skips and warns when the pass carries a warn message', async () => {
      const h = makeHarness();
      const tick = slowTick({ warn: 'previous tick still running; skipping' });
      await startWorker(makeSpec(h, { ticks: [tick.job] }), h.runtime);

      await vi.advanceTimersByTimeAsync(10 * SECOND);
      await vi.advanceTimersByTimeAsync(10 * SECOND);

      expect(tick.stats()).toEqual({ calls: 2, maxConcurrent: 1 });
      expect(h.log.warn).toHaveBeenCalledWith('previous tick still running; skipping');
    });

    it('lets passes overlap when overlap is allow', async () => {
      const h = makeHarness();
      const tick = slowTick('allow');
      await startWorker(makeSpec(h, { ticks: [tick.job] }), h.runtime);

      await vi.advanceTimersByTimeAsync(10 * SECOND);
      await vi.advanceTimersByTimeAsync(10 * SECOND);

      expect(tick.stats()).toEqual({ calls: 3, maxConcurrent: 2 });
    });
  });
});

describe('startWorker shutdown', () => {
  it('stops intervals and the heartbeat, emits stopped, closes Postgres then Redis, exits 0', async () => {
    const events: string[] = [];
    const h = makeHarness(events);
    h.redis.xadd.mockImplementation(async (...args: unknown[]) => {
      events.push(`diag:${String(args[args.indexOf('kind') + 1])}`);
      return '1-0';
    });
    const run = vi.fn().mockResolvedValue(undefined);
    await startWorker(makeSpec(h, { ticks: [tickJob({ run })] }, { postgres: {} }), h.runtime);
    await settle();
    const heartbeatsBefore = h.redis.set.mock.calls.length;

    h.signals.emit('SIGTERM');
    await settle();
    await vi.advanceTimersByTimeAsync(60 * SECOND);

    expect(events).toEqual([
      'diag:role_expirer.started',
      'diag:role_expirer.stopped',
      'sql.end',
      'redis.quit',
    ]);
    expect(h.sql.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(JSON.parse(h.diagField(1, 'payload'))).toEqual({ sig: 'SIGTERM' });
    expect(h.diagField(1, 'message')).toBe('role-expirer received SIGTERM');
    expect(h.log.info).toHaveBeenCalledWith({ sig: 'SIGTERM' }, 'shutdown');
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.redis.set.mock.calls.length).toBe(heartbeatsBefore);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('runs the shutdown once for a repeated signal', async () => {
    const h = makeHarness();
    await startWorker(makeSpec(h, { ticks: [] }, { postgres: {} }), h.runtime);

    h.signals.emit('SIGTERM');
    h.signals.emit('SIGINT');
    h.signals.emit('SIGTERM');
    await settle();

    expect(h.sql.end).toHaveBeenCalledTimes(1);
    expect(h.redis.quit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('remembers a signal that arrives during the startup pass and never arms the intervals', async () => {
    const h = makeHarness();
    let finishFirstPass: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirstPass = resolve;
        }),
    );
    const started = startWorker(
      makeSpec(h, { ticks: [tickJob({ run })] }, { postgres: {} }),
      h.runtime,
    );
    await settle();

    h.signals.emit('SIGTERM');
    await settle();
    expect(h.exit).not.toHaveBeenCalled();

    finishFirstPass?.();
    await started;
    await settle();
    await vi.advanceTimersByTimeAsync(60 * SECOND);

    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.diagKinds()).toEqual(['role_expirer.started', 'role_expirer.stopped']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs shutdown failed and exits 1 when closing Postgres fails', async () => {
    const h = makeHarness();
    h.sql.end.mockRejectedValue(new Error('pool stuck'));
    await startWorker(makeSpec(h, { ticks: [] }, { postgres: {} }), h.runtime);

    h.signals.emit('SIGTERM');
    await settle();

    expect(h.log.error).toHaveBeenCalledWith({ err: 'pool stuck' }, 'shutdown failed');
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('ignores a failing Redis quit', async () => {
    const h = makeHarness();
    h.redis.quit.mockRejectedValue(new Error('already closed'));
    await startWorker(makeSpec(h, { ticks: [] }), h.runtime);

    h.signals.emit('SIGTERM');
    await settle();

    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('runWorker', () => {
  it('does not start a worker whose module is only imported', async () => {
    const h = makeHarness();
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);

    runWorker({
      name: 'role-expirer',
      log: h.log as unknown as Logger,
      entrypoint: pathToFileURL('/definitely/not/the/entry/script.js').href,
      setup,
    });
    await settle();

    expect(setup).not.toHaveBeenCalled();
    expect(h.log.fatal).not.toHaveBeenCalled();
  });

  it('logs fatal and exits 1 when startup fails in the entry script', async () => {
    const h = makeHarness();
    vi.stubEnv('DATABASE_URL', '');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const setup = vi.fn(() => ({ ticks: [] }) satisfies WorkerPlan);

    runWorker({
      name: 'role-expirer',
      log: h.log as unknown as Logger,
      entrypoint: pathToFileURL(String(process.argv[1])).href,
      postgres: {},
      setup,
    });
    await settle();

    expect(h.log.fatal).toHaveBeenCalledWith('DATABASE_URL is required');
    expect(h.log.fatal).toHaveBeenCalledWith({ err: 'DATABASE_URL is required' }, 'fatal');
    expect(exit).toHaveBeenCalledWith(1);
    expect(setup).not.toHaveBeenCalled();
  });
});

describe('typed context', () => {
  it('types sql, db and redis from the declared resources', () => {
    const h = makeHarness();
    const required: WorkerSpec<{ drizzle: true }, undefined> = {
      name: 'a',
      log: h.log as unknown as Logger,
      entrypoint: 'file:///unused.js',
      postgres: { drizzle: true },
      setup: (ctx) => {
        const sql: postgres.Sql = ctx.sql;
        const db: DatabaseClient = ctx.db;
        const redis: Redis = ctx.redis;
        void [sql, db, redis];
        return { ticks: [] };
      },
    };
    const optional: WorkerSpec<{ optional: true }, { optional: true }> = {
      name: 'b',
      log: h.log as unknown as Logger,
      entrypoint: 'file:///unused.js',
      postgres: { optional: true },
      redis: { optional: true },
      setup: (ctx) => {
        const sql: postgres.Sql | null = ctx.sql;
        const redis: Redis | null = ctx.redis;
        void [sql, redis];
        return { ticks: [] };
      },
    };
    expect([required.name, optional.name]).toEqual(['a', 'b']);
  });
});
