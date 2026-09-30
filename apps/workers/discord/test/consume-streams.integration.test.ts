import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEnvelope } from '@squad/shared-types';
import Redis from 'ioredis';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureConsumerGroup, runNotifyLoop } from '../src/consume.js';
import { deliverEnvelope } from '../src/sender.js';

// Only the Discord side is faked: stream discovery, consumer groups and
// XREADGROUP run against a real Redis.
vi.mock('../src/sender.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sender.js')>();
  return { ...actual, deliverEnvelope: vi.fn() };
});

const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? '14';
const TEST_REDIS_URL = `${(
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
).replace(/\/\d+$/, '')}/${TEST_REDIS_DB}`;

const delivered: EventEnvelope[] = [];
vi.mocked(deliverEnvelope).mockImplementation(async (_deps, envelope) => {
  delivered.push(envelope);
  return { sent: 1, failed: 0, rateLimited: 0 };
});

function makeEnvelope(): EventEnvelope {
  return {
    event_id: randomUUID(),
    version: 1,
    type: 'server.crashed',
    server_id: null,
    ts: new Date().toISOString(),
    actor: null,
    correlation_id: null,
    payload: { pid: null, reason: 'test', exit_code: 1 },
  };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil: timed out');
    await sleep(50);
  }
}

/**
 * #60 finding 1291: groups on newly discovered streams started at '$', so the
 * first events of a new server's stream never reached Discord, and a deleted
 * then re-created stream stalled the multiplexed read on NOGROUP for good.
 */
describe('runNotifyLoop stream lifecycle (integration)', () => {
  let redis: Redis | null = null;
  let stopped = false;
  let loop: Promise<void> | null = null;
  let keys: string[] = [];

  afterEach(async () => {
    stopped = true;
    await loop?.catch(() => undefined);
    for (const key of keys) await redis?.del(key).catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    redis = null;
    loop = null;
    keys = [];
    stopped = false;
    delivered.length = 0;
  });

  function startLoop(
    group: string,
    discoverStreams: () => Promise<string[]>,
    streamRefreshMs?: number,
  ) {
    loop = runNotifyLoop({
      redis: redis as Redis,
      log: pino({ enabled: false }),
      group,
      consumer: `test-consumer-${randomUUID()}`,
      blockMs: 200,
      shouldStop: () => stopped,
      discoverStreams,
      streamRefreshMs,
      db: {} as never,
      encryptionKey: Buffer.alloc(32),
      fetchImpl: vi.fn(),
      sleep: vi.fn(async () => undefined),
      panelBaseUrl: null,
    });
  }

  it('delivers the first events of a stream that appears while the loop runs', async () => {
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const group = `test-group-${randomUUID()}`;
    const anchor = `events:test:${randomUUID()}`;
    const stream = `events:test:${randomUUID()}`;
    keys = [anchor, stream];
    let streamExists = false;
    startLoop(group, async () => (streamExists ? [anchor, stream] : [anchor]), 100);
    await sleep(400);

    const first = makeEnvelope();
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(first));
    streamExists = true;

    await pollUntil(() => delivered.length === 1);
    expect(delivered[0]?.event_id).toBe(first.event_id);
  });

  it('keeps reading after a known stream is deleted and re-created', async () => {
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const group = `test-group-${randomUUID()}`;
    const stream = `events:test:${randomUUID()}`;
    keys = [stream];
    await ensureConsumerGroup(redis, stream, group);
    startLoop(group, async () => [stream]);
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(makeEnvelope()));
    await pollUntil(() => delivered.length === 1);

    await redis.del(stream);
    const after = makeEnvelope();
    await redis.xadd(stream, '*', 'envelope', JSON.stringify(after));

    await pollUntil(() => delivered.length === 2);
    expect(delivered[1]?.event_id).toBe(after.event_id);
  });
});
