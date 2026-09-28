import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DELIVERY_ATTEMPTS,
  NOTIFY_CONSUMER_GROUP,
  parseStreamEnvelope,
  runNotifyLoop,
} from '../src/consume.js';
import { deliverEnvelope } from '../src/sender.js';

vi.mock('../src/sender.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sender.js')>();
  return { ...actual, deliverEnvelope: vi.fn() };
});

const deliverEnvelopeMock = vi.mocked(deliverEnvelope);

const silentLog = pino({ enabled: false });

function fakeRedis() {
  const calls: string[] = [];
  const dedup = new Map<string, string>();
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
    incr: vi.fn(async (key: string) => {
      calls.push(`incr:${key}`);
      const next = Number(dedup.get(key) ?? '0') + 1;
      dedup.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => {
      calls.push(`del:${key}`);
      return dedup.delete(key) ? 1 : 0;
    }),
  };
}

const ENVELOPE_JSON = JSON.stringify({
  event_id: '11111111-1111-1111-1111-111111111111',
  version: 1,
  type: 'server.crashed',
  server_id: null,
  ts: '2026-07-14T00:00:00.000Z',
  actor: null,
  correlation_id: null,
  payload: { pid: null, reason: 'test', exit_code: 1 },
});

beforeEach(() => {
  deliverEnvelopeMock.mockReset();
});

describe('parseStreamEnvelope', () => {
  it('parses a valid envelope field', () => {
    const parsed = parseStreamEnvelope(['envelope', ENVELOPE_JSON]);
    expect(parsed?.event_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('returns null for malformed JSON', () => {
    expect(parseStreamEnvelope(['envelope', '{not json'])).toBeNull();
  });

  it('returns null when the envelope field is missing', () => {
    expect(parseStreamEnvelope(['other', 'x'])).toBeNull();
  });

  it('returns null when the parsed JSON fails schema validation', () => {
    expect(parseStreamEnvelope(['envelope', JSON.stringify({ foo: 'bar' })])).toBeNull();
  });
});

/**
 * Drives exactly one XREADGROUP response then stops the loop, so each test
 * exercises a single `processEntry` call deterministically.
 */
function runOneBatch(redis: ReturnType<typeof fakeRedis>, entries: Array<[string, string[]]>) {
  let served = false;
  const redisFull = {
    ...redis,
    scan: vi.fn(async () => ['0', []]),
    xgroup: vi.fn(async () => 'OK'),
    xautoclaim: vi.fn(async () => ['0-0', [], []]),
    xreadgroup: vi.fn(async () => {
      if (served) return null;
      served = true;
      return [['events:global', entries]];
    }),
  };
  return redisFull;
}

describe('runNotifyLoop', () => {
  it('acks and never delivers when the dedup key already exists (crash-after-send redelivery suppressed)', async () => {
    const redis = fakeRedis();
    redis.dedup.set(`dedup:${NOTIFY_CONSUMER_GROUP}:11111111-1111-1111-1111-111111111111`, '1');
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(deliverEnvelopeMock).not.toHaveBeenCalled();
    expect(redis.calls).toContain('xack:events:global:1-0');
  });

  it('delivers then SETs the dedup key then XACKs, in that order', async () => {
    deliverEnvelopeMock.mockResolvedValue({ sent: 1, failed: 0, rateLimited: 0 });
    const redis = fakeRedis();
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(deliverEnvelopeMock).toHaveBeenCalledTimes(1);
    const dedupKey = `dedup:${NOTIFY_CONSUMER_GROUP}:11111111-1111-1111-1111-111111111111`;
    const setIdx = redis.calls.indexOf(`set:${dedupKey}`);
    const ackIdx = redis.calls.indexOf('xack:events:global:1-0');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeGreaterThan(setIdx);
  });

  it('does not ack when deliverEnvelope throws — the entry is left pending for redelivery', async () => {
    deliverEnvelopeMock.mockRejectedValue(new Error('db unreachable'));
    const redis = fakeRedis();
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(redis.calls).not.toContain('xack:events:global:1-0');
  });

  it('acks a malformed envelope without invoking deliverEnvelope, and continues the loop', async () => {
    const redis = fakeRedis();
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', '{not json']]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(deliverEnvelopeMock).not.toHaveBeenCalled();
    expect(redis.calls).toContain('xack:events:global:1-0');
  });

  it('reclaims and delivers an entry orphaned by a crashed consumer (no-loss after a kill mid-send)', async () => {
    deliverEnvelopeMock.mockResolvedValue({ sent: 1, failed: 0, rateLimited: 0 });
    const redis = fakeRedis();
    let stop = false;
    const redisFull = {
      ...redis,
      scan: vi.fn(async () => ['0', []]),
      xgroup: vi.fn(async () => 'OK'),
      // No new entries via '>' — the entry is only sitting in another
      // (crashed) consumer's pending list, exactly like a process killed
      // mid-send: XREADGROUP alone would never see it again.
      xreadgroup: vi.fn(async () => {
        stop = true;
        return null;
      }),
      xautoclaim: vi.fn(async () => ['0-0', [['1-0', ['envelope', ENVELOPE_JSON]]], []]),
    };

    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => ['events:global'],
    });

    expect(deliverEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(redis.calls).toContain('xack:events:global:1-0');
  });

  it('leaves the entry pending and sets no dedup key when a webhook delivery failed (#879)', async () => {
    deliverEnvelopeMock.mockResolvedValue({ sent: 0, failed: 1, rateLimited: 0 });
    const redis = fakeRedis();
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    const dedupKey = `dedup:${NOTIFY_CONSUMER_GROUP}:11111111-1111-1111-1111-111111111111`;
    expect(redis.calls).not.toContain('xack:events:global:1-0');
    expect(redis.calls).not.toContain(`set:${dedupKey}`);
  });

  it('acks a still-failing entry once it has used up every delivery attempt (#879)', async () => {
    deliverEnvelopeMock.mockResolvedValue({ sent: 0, failed: 1, rateLimited: 0 });
    const redis = fakeRedis();
    const eventId = '11111111-1111-1111-1111-111111111111';
    redis.dedup.set(
      `discord:notify:attempts:${NOTIFY_CONSUMER_GROUP}:${eventId}`,
      String(MAX_DELIVERY_ATTEMPTS - 1),
    );
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(redis.calls).toContain('xack:events:global:1-0');
  });

  it('hands deliverEnvelope a per-webhook ledger so a retry never re-posts to a webhook that already got the embed (#879)', async () => {
    deliverEnvelopeMock.mockImplementation(async (_deps, _envelope, ledger) => {
      await ledger?.markDelivered('wh-1');
      expect(await ledger?.isDelivered('wh-1')).toBe(true);
      expect(await ledger?.isDelivered('wh-2')).toBe(false);
      return { sent: 1, failed: 1, rateLimited: 0 };
    });
    const redis = fakeRedis();
    const redisFull = runOneBatch(redis, [['1-0', ['envelope', ENVELOPE_JSON]]]);

    let stop = false;
    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      shouldStop: () => stop,
      discoverStreams: async () => {
        stop = true;
        return ['events:global'];
      },
    });

    expect(deliverEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(
      redis.dedup.has(`dedup:${NOTIFY_CONSUMER_GROUP}:11111111-1111-1111-1111-111111111111:wh-1`),
    ).toBe(true);
  });

  it('re-creates a consumer group that disappeared after a NOGROUP read instead of stalling forever (#881)', async () => {
    const redis = fakeRedis();
    let reads = 0;
    let stop = false;
    const redisFull = {
      ...redis,
      scan: vi.fn(async () => ['0', []]),
      xgroup: vi.fn(async () => 'OK'),
      xautoclaim: vi.fn(async () => ['0-0', [], []]),
      xreadgroup: vi.fn(async () => {
        reads++;
        if (reads === 2) {
          throw new Error(
            "NOGROUP No such key 'events:global' or consumer group 'discord-notify:v1'",
          );
        }
        if (reads >= 3) stop = true;
        return null;
      }),
    };

    await runNotifyLoop({
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
      redis: redisFull as any,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      log: silentLog,
      panelBaseUrl: null,
      blockMs: 1,
      shouldStop: () => stop,
      discoverStreams: async () => ['events:global'],
    });

    // Once on first sight, and once more after the NOGROUP error.
    expect(redisFull.xgroup).toHaveBeenCalledTimes(2);
  });

  it('keeps looping when creating a consumer group fails instead of rejecting (#880)', async () => {
    const redis = fakeRedis();
    let groupAttempts = 0;
    let stop = false;
    const redisFull = {
      ...redis,
      scan: vi.fn(async () => ['0', []]),
      xgroup: vi.fn(async () => {
        groupAttempts++;
        if (groupAttempts === 1) throw new Error('LOADING Redis is loading the dataset in memory');
        return 'OK';
      }),
      xautoclaim: vi.fn(async () => ['0-0', [], []]),
      xreadgroup: vi.fn(async () => {
        stop = true;
        return null;
      }),
    };

    await expect(
      runNotifyLoop({
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake redis matching only what consume.ts calls
        redis: redisFull as any,
        db: {} as never,
        encryptionKey: Buffer.alloc(32),
        fetchImpl: vi.fn(),
        sleep: vi.fn(async () => undefined),
        log: silentLog,
        panelBaseUrl: null,
        blockMs: 1,
        shouldStop: () => stop,
        discoverStreams: async () => ['events:global'],
      }),
    ).resolves.toBeUndefined();

    expect(groupAttempts).toBe(2);
    expect(redisFull.xreadgroup).toHaveBeenCalled();
  });
});
