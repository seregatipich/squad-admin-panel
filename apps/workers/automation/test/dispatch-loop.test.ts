import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@squad/shared-types';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_CONSUMER_GROUP, runDispatchLoop } from '../src/dispatch.js';
import { PluginRegistry } from '../src/registry.js';

const silentLog = pino({ enabled: false });

function envelopeJson(eventId = randomUUID()): string {
  const envelope: EventEnvelope = {
    event_id: eventId,
    version: 1,
    type: 'server.ready',
    server_id: null,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {},
  };
  return JSON.stringify(envelope);
}

type Entries = Array<[string, string[]]>;

/**
 * An in-memory stand-in for exactly the Redis calls the dispatch loop makes.
 * `reads` is served one element per XREADGROUP call; `claims` one element per
 * XAUTOCLAIM call. Every call is recorded in order in `calls`.
 */
function fakeRedis(opts: { reads?: Array<Entries | Error | null>; claims?: Entries[] } = {}) {
  const calls: string[] = [];
  const dedup = new Map<string, string>();
  const reads = [...(opts.reads ?? [])];
  const claims = [...(opts.claims ?? [])];
  return {
    calls,
    dedup,
    get: vi.fn(async (key: string) => {
      calls.push(`get:${key}`);
      return dedup.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      calls.push(`set:${key}`);
      if (dedup.has(key)) return null;
      dedup.set(key, value);
      return 'OK';
    }),
    xack: vi.fn(async (stream: string, _group: string, id: string) => {
      calls.push(`xack:${stream}:${id}`);
      return 1;
    }),
    xgroup: vi.fn(async (...args: unknown[]) => {
      calls.push(`xgroup:${args[1]}:${args[3]}`);
      return 'OK';
    }),
    xautoclaim: vi.fn(async (stream: string) => {
      calls.push(`xautoclaim:${stream}`);
      return ['0-0', claims.shift() ?? [], []];
    }),
    xreadgroup: vi.fn(async () => {
      calls.push('xreadgroup');
      const next = reads.shift() ?? null;
      if (next instanceof Error) throw next;
      return next ? [['events:global', next]] : null;
    }),
  };
}

/** Stops the loop after `iterations` checks of `shouldStop`. */
function stopAfter(iterations: number): () => boolean {
  let checks = 0;
  return () => checks++ >= iterations;
}

function baseOpts(redis: ReturnType<typeof fakeRedis>) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what dispatch.ts calls
    redis: redis as any,
    registry: new PluginRegistry(),
    log: silentLog,
    blockMs: 1,
  };
}

describe('runDispatchLoop — delivery guarantees (#841)', () => {
  it('runs the hook, then SETs the dedup key, then XACKs', async () => {
    const eventId = randomUUID();
    const redis = fakeRedis({ reads: [[['1-0', ['envelope', envelopeJson(eventId)]]]] });
    const onEnvelope = vi.fn(async () => undefined);

    await runDispatchLoop({
      ...baseOpts(redis),
      onEnvelope,
      shouldStop: stopAfter(1),
      discoverStreams: async () => ['events:global'],
    });

    const dedupKey = `dedup:${DISPATCH_CONSUMER_GROUP}:${eventId}`;
    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(redis.calls.indexOf(`set:${dedupKey}`)).toBeGreaterThan(-1);
    expect(redis.calls.indexOf('xack:events:global:1-0')).toBeGreaterThan(
      redis.calls.indexOf(`set:${dedupKey}`),
    );
  });

  it('leaves the entry pending and unclaimed when the onEnvelope hook fails', async () => {
    const eventId = randomUUID();
    const redis = fakeRedis({ reads: [[['1-0', ['envelope', envelopeJson(eventId)]]]] });

    await runDispatchLoop({
      ...baseOpts(redis),
      onEnvelope: async () => {
        throw new Error('database unavailable');
      },
      shouldStop: stopAfter(1),
      discoverStreams: async () => ['events:global'],
    });

    expect(redis.calls).not.toContain('xack:events:global:1-0');
    expect(redis.dedup.has(`dedup:${DISPATCH_CONSUMER_GROUP}:${eventId}`)).toBe(false);
  });

  it('only acks an entry whose dedup key already exists', async () => {
    const eventId = randomUUID();
    const redis = fakeRedis({ reads: [[['1-0', ['envelope', envelopeJson(eventId)]]]] });
    redis.dedup.set(`dedup:${DISPATCH_CONSUMER_GROUP}:${eventId}`, '1');
    const onEnvelope = vi.fn(async () => undefined);

    await runDispatchLoop({
      ...baseOpts(redis),
      onEnvelope,
      shouldStop: stopAfter(1),
      discoverStreams: async () => ['events:global'],
    });

    expect(onEnvelope).not.toHaveBeenCalled();
    expect(redis.calls).toContain('xack:events:global:1-0');
  });

  it('reclaims an entry left pending by a crashed consumer and processes it', async () => {
    const redis = fakeRedis({ claims: [[['1-0', ['envelope', envelopeJson()]]]] });
    const onEnvelope = vi.fn(async () => undefined);

    await runDispatchLoop({
      ...baseOpts(redis),
      onEnvelope,
      shouldStop: stopAfter(1),
      discoverStreams: async () => ['events:global'],
    });

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(redis.calls).toContain('xack:events:global:1-0');
  });
});

describe('runDispatchLoop — stream discovery and reclaim are throttled (#843)', () => {
  it('scans for streams and reclaims once per interval, not on every poll', async () => {
    const redis = fakeRedis();
    const discoverStreams = vi.fn(async () => ['events:global']);
    let clock = 0;

    await runDispatchLoop({
      ...baseOpts(redis),
      shouldStop: stopAfter(5),
      discoverStreams,
      now: () => clock++,
      streamRefreshMs: 1_000,
      reclaimIntervalMs: 1_000,
    });

    expect(redis.xreadgroup).toHaveBeenCalledTimes(5);
    expect(discoverStreams).toHaveBeenCalledTimes(1);
    expect(redis.xautoclaim).toHaveBeenCalledTimes(1);
  });

  it('re-discovers once the refresh interval elapses', async () => {
    const redis = fakeRedis();
    const discoverStreams = vi.fn(async () => ['events:global']);
    let clock = 0;

    await runDispatchLoop({
      ...baseOpts(redis),
      shouldStop: stopAfter(3),
      discoverStreams,
      now: () => {
        clock += 1_000;
        return clock;
      },
      streamRefreshMs: 1_000,
    });

    expect(discoverStreams).toHaveBeenCalledTimes(3);
  });
});

describe('runDispatchLoop — consumer-group resilience (#844)', () => {
  it('creates new consumer groups from the start of the stream', async () => {
    const redis = fakeRedis();

    await runDispatchLoop({
      ...baseOpts(redis),
      shouldStop: stopAfter(1),
      discoverStreams: async () => ['events:global'],
    });

    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      'events:global',
      DISPATCH_CONSUMER_GROUP,
      '0',
      'MKSTREAM',
    );
  });

  it('survives a failing group creation and retries it on the next iteration', async () => {
    const redis = fakeRedis();
    redis.xgroup.mockRejectedValueOnce(new Error('LOADING Redis is loading the dataset'));

    await expect(
      runDispatchLoop({
        ...baseOpts(redis),
        shouldStop: stopAfter(2),
        discoverStreams: async () => ['events:global'],
      }),
    ).resolves.toBeUndefined();

    expect(redis.xgroup).toHaveBeenCalledTimes(2);
    expect(redis.xreadgroup).toHaveBeenCalledTimes(1);
  });

  it('re-creates the consumer group after a NOGROUP read error', async () => {
    const redis = fakeRedis({ reads: [new Error('NOGROUP No such key or consumer group'), null] });

    await runDispatchLoop({
      ...baseOpts(redis),
      shouldStop: stopAfter(2),
      discoverStreams: async () => ['events:global'],
    });

    expect(redis.xgroup).toHaveBeenCalledTimes(2);
  });
});
