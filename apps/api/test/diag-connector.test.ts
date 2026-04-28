import type { DatabaseClient } from '@squad/db';
import type { Diag, DiagEvent } from '@squad/diag';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import diagPlugin from '../src/lib/diag.js';
import dbHealthPlugin, { pgHealthTick } from '../src/plugins/db-health.js';
import redisPlugin from '../src/plugins/redis.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

interface BuiltApp {
  app: FastifyInstance;
  captured: DiagEvent[];
}

async function buildAppWithRedisPlugin(): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  await app.register(redisPlugin, {
    config: { REDIS_URL: TEST_REDIS_URL } as Parameters<typeof redisPlugin>[1]['config'],
  });
  await app.register(diagPlugin);

  const captured: DiagEvent[] = [];
  (app as unknown as { diag: Diag }).diag.emit = async (ev) => {
    captured.push(ev);
  };

  return { app, captured };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

let activeApps: FastifyInstance[] = [];

beforeEach(() => {
  activeApps = [];
});

afterEach(async () => {
  for (const app of activeApps) {
    await app.close().catch(() => undefined);
  }
});

describe('redis listeners emit diag events', () => {
  it('emits redis.ping.fail on error event, then reconnect.success on ready', async () => {
    const { app, captured } = await buildAppWithRedisPlugin();
    activeApps.push(app);

    app.redis.emit('error', new Error('connection lost'));
    await flushMicrotasks();
    expect(captured.some((e) => e.kind === 'redis.ping.fail')).toBe(true);

    app.redis.emit('ready');
    await flushMicrotasks();
    expect(captured.some((e) => e.kind === 'redis.reconnect.success')).toBe(true);
  });

  it('does not emit reconnect.success on ready without a prior error (clean startup)', async () => {
    const { app, captured } = await buildAppWithRedisPlugin();
    activeApps.push(app);

    app.redis.emit('ready');
    await flushMicrotasks();
    expect(captured.some((e) => e.kind === 'redis.reconnect.success')).toBe(false);
  });

  it('emits redis.reconnect.attempt on reconnecting event', async () => {
    const { app, captured } = await buildAppWithRedisPlugin();
    activeApps.push(app);

    app.redis.emit('reconnecting');
    await flushMicrotasks();
    expect(captured.some((e) => e.kind === 'redis.reconnect.attempt')).toBe(true);
  });

  it('redis error event emits diag.ping.fail with severity error and err in payload', async () => {
    const { app, captured } = await buildAppWithRedisPlugin();
    activeApps.push(app);

    app.redis.emit('error', new Error('ECONNREFUSED'));
    await flushMicrotasks();
    const ev = captured.find((e) => e.kind === 'redis.ping.fail');
    expect(ev).toBeDefined();
    expect(ev?.component).toBe('api');
    expect(ev?.severity).toBe('error');
    expect(ev?.payload).toEqual({ err: 'ECONNREFUSED' });
  });
});

describe('postgres health-check emits diag events', () => {
  function buildHealthApp(stub: { execute: (q: unknown) => Promise<unknown> }): BuiltApp {
    const app = Fastify({ logger: false });
    const fakeRedis = {
      async xadd(..._args: unknown[]) {
        return '0-0';
      },
    };
    (app as unknown as { redis: unknown }).redis = fakeRedis;
    (app as unknown as { db: { execute: (q: unknown) => Promise<unknown> } }).db = stub;

    return { app } as BuiltApp;
  }

  it('emits pg.ping.fail when SELECT 1 throws, then pg.ping.ok on recovery', async () => {
    let calls = 0;
    const stub = {
      async execute(_q: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('pg connection refused');
        return [];
      },
    };
    const built = buildHealthApp(stub);
    await built.app.register(diagPlugin);
    await built.app.register(dbHealthPlugin);
    activeApps.push(built.app);

    const captured: DiagEvent[] = [];
    (built.app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    await pgHealthTick(built.app);
    await pgHealthTick(built.app);

    const fail = captured.find((e) => e.kind === 'pg.ping.fail');
    const ok = captured.find((e) => e.kind === 'pg.ping.ok');
    expect(fail).toBeDefined();
    expect(fail?.severity).toBe('error');
    expect(fail?.payload).toEqual({ err: 'pg connection refused' });
    expect(ok).toBeDefined();
    expect(ok?.severity).toBe('info');
  });

  it('does not emit pg.ping.ok on the first successful tick (clean startup is silent)', async () => {
    const stub = {
      async execute(_q: unknown) {
        return [];
      },
    };
    const built = buildHealthApp(stub);
    await built.app.register(diagPlugin);
    await built.app.register(dbHealthPlugin);
    activeApps.push(built.app);

    const captured: DiagEvent[] = [];
    (built.app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    await pgHealthTick(built.app);
    await pgHealthTick(built.app);

    expect(captured.some((e) => e.kind === 'pg.ping.ok')).toBe(false);
    expect(captured.some((e) => e.kind === 'pg.ping.fail')).toBe(false);
  });

  it('emits pg.ping.fail on every consecutive failure but pg.ping.ok only once on recovery', async () => {
    let calls = 0;
    const stub = {
      async execute(_q: unknown) {
        calls += 1;
        if (calls <= 2) throw new Error('still down');
        return [];
      },
    };
    const built = buildHealthApp(stub);
    await built.app.register(diagPlugin);
    await built.app.register(dbHealthPlugin);
    activeApps.push(built.app);

    const captured: DiagEvent[] = [];
    (built.app as unknown as { diag: Diag }).diag.emit = async (ev) => {
      captured.push(ev);
    };

    await pgHealthTick(built.app);
    await pgHealthTick(built.app);
    await pgHealthTick(built.app);
    await pgHealthTick(built.app);

    const fails = captured.filter((e) => e.kind === 'pg.ping.fail');
    const oks = captured.filter((e) => e.kind === 'pg.ping.ok');
    expect(fails.length).toBe(2);
    expect(oks.length).toBe(1);
  });
});

describe('redis listener uses live ioredis instance from real plugin', () => {
  it('decorator app.redis is a real Redis client', async () => {
    const { app } = await buildAppWithRedisPlugin();
    activeApps.push(app);
    expect(app.redis).toBeInstanceOf(Redis);
  });

  it('captures app.db without registering db plugin', async () => {
    const stub = {
      async execute(_q: unknown) {
        return [];
      },
    } as unknown as DatabaseClient;
    const app = Fastify({ logger: false });
    const fakeRedis = {
      async xadd(..._args: unknown[]) {
        return '0-0';
      },
    };
    (app as unknown as { redis: unknown }).redis = fakeRedis;
    (app as unknown as { db: DatabaseClient }).db = stub;
    await app.register(diagPlugin);
    await app.register(dbHealthPlugin);
    activeApps.push(app);
    expect(app.db).toBe(stub);
  });
});
