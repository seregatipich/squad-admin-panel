import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDbAndRedis } from '../../../../packages/db/test/helpers/describe-if.js';
import { runStreamConsumer, scanStreams } from '../src/stream-consumer.js';

const REDIS_URL = process.env.REDIS_URL;

const redis = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
const blocking = new Redis(REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const RUN = randomUUID();
const keysToDelete: string[] = [];
const log = { warn: vi.fn(), error: vi.fn() };

function streamKey(name: string): string {
  const key = `test:stream-consumer:${RUN}:${name}`;
  keysToDelete.push(key);
  return key;
}

async function waitFor(probe: () => boolean | Promise<boolean>, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

beforeAll(async () => {
  if (!REDIS_URL) return;
  await redis.connect();
  await blocking.connect();
});

afterAll(async () => {
  if (!REDIS_URL) return;
  const dedup = await redis.keys(`dedup:test-group-${RUN}*`);
  await redis.del(...keysToDelete, ...dedup);
  await blocking.quit();
  await redis.quit();
});

/** Starts a consumer; the returned `stop` ends it and resolves once the loop exited. */
function start(
  stream: string,
  handle: (stream: string, id: string, fields: string[]) => Promise<void>,
  extra: Partial<Parameters<typeof runStreamConsumer>[0]> = {},
) {
  let stopping = false;
  const loop = runStreamConsumer({
    redis: blocking,
    log,
    group: `test-group-${RUN}`,
    consumer: 'test-consumer',
    discoverStreams: async () => [stream],
    handle,
    shouldStop: () => stopping,
    blockMs: 50,
    ...extra,
  });
  return {
    stop: async () => {
      stopping = true;
      await loop;
    },
  };
}

describeIfDbAndRedis('runStreamConsumer', () => {
  it('delivers entries added after the first discovery and acks them', async () => {
    const stream = streamKey('deliver');
    await redis.xadd(stream, '*', 'k', 'before');
    const seen: string[] = [];
    const consumer = start(stream, async (_s, _id, fields) => {
      seen.push(fields[1] as string);
    });
    await waitFor(async () => {
      const groups = (await redis.xinfo('GROUPS', stream)) as unknown[][];
      return groups.length === 1;
    });
    await redis.xadd(stream, '*', 'k', 'after');
    await waitFor(() => seen.length === 1);
    await consumer.stop();

    // A first start does not replay history.
    expect(seen).toEqual(['after']);
    expect(((await redis.xpending(stream, `test-group-${RUN}`)) as [number])[0]).toBe(0);
  });

  it('retries an entry whose handler rejected, after it idled long enough', async () => {
    const stream = streamKey('retry');
    await redis.xadd(stream, '*', 'k', 'seed');
    let attempts = 0;
    const consumer = start(
      stream,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database down');
      },
      { reclaimMinIdleMs: 50, reclaimIntervalMs: 50 },
    );
    await waitFor(async () => ((await redis.xinfo('GROUPS', stream)) as unknown[][]).length === 1);
    await redis.xadd(stream, '*', 'k', 'retry-me');
    await waitFor(() => attempts >= 2);
    await waitFor(
      async () => ((await redis.xpending(stream, `test-group-${RUN}`)) as [number])[0] === 0,
    );
    await consumer.stop();
    expect(attempts).toBe(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stream }),
      expect.stringContaining('left pending'),
    );
  });

  it('skips and acks an entry an earlier delivery already handled when dedupeByEntry is set', async () => {
    const stream = streamKey('dedupe');
    await redis.xadd(stream, '*', 'k', 'seed');
    const handled: string[] = [];
    const consumer = start(
      stream,
      async (_s, _id, fields) => {
        handled.push(fields[1] as string);
      },
      { dedupeByEntry: true },
    );
    await waitFor(async () => ((await redis.xinfo('GROUPS', stream)) as unknown[][]).length === 1);

    // An entry whose dedup key exists was fully handled by a delivery whose ack was lost.
    const replayedId = `${Date.now() + 1_000_000}-0`;
    await redis.set(`dedup:test-group-${RUN}:${stream}:${replayedId}`, '1', 'EX', 60);
    await redis.xadd(stream, replayedId, 'k', 'replayed');
    const freshId = (await redis.xadd(stream, '*', 'k', 'fresh')) as string;
    await waitFor(() => handled.includes('fresh'));
    await waitFor(
      async () => ((await redis.xpending(stream, `test-group-${RUN}`)) as [number])[0] === 0,
    );
    await consumer.stop();

    expect(handled).toEqual(['fresh']);
    expect(await redis.exists(`dedup:test-group-${RUN}:${stream}:${freshId}`)).toBe(1);
  });

  it('starts a stream first seen later at the beginning, so its first entry is delivered', async () => {
    const early = streamKey('early');
    const late = streamKey('late');
    await redis.xadd(early, '*', 'k', 'seed');
    let streams = [early];
    const seen: string[] = [];
    const consumer = start(
      early,
      async (_s, _id, fields) => {
        seen.push(fields[1] as string);
      },
      { discoverStreams: async () => streams, streamRefreshMs: 30 },
    );
    await waitFor(async () => ((await redis.xinfo('GROUPS', early)) as unknown[][]).length === 1);
    // `late` appears with an entry already in it, as a new server's first message does.
    await redis.xadd(late, '*', 'k', 'first-ever');
    streams = [early, late];
    await waitFor(() => seen.includes('first-ever'));
    await consumer.stop();
    expect(seen).toEqual(['first-ever']);
  });

  it('recovers from a stream deleted under it (NOGROUP)', async () => {
    const stream = streamKey('nogroup');
    await redis.xadd(stream, '*', 'k', 'seed');
    const seen: string[] = [];
    const consumer = start(stream, async (_s, _id, fields) => {
      seen.push(fields[1] as string);
    });
    await waitFor(async () => ((await redis.xinfo('GROUPS', stream)) as unknown[][]).length === 1);
    await redis.del(stream);
    await sleep(100);
    await redis.xadd(stream, '*', 'k', 'reborn');
    await waitFor(() => seen.includes('reborn'), 8000);
    await consumer.stop();
  }, 12_000);
});

describeIfDbAndRedis('scanStreams', () => {
  it('returns the keys the filter accepts', async () => {
    const a = streamKey('scan:a');
    const b = streamKey('scan:b:shadow');
    await redis.xadd(a, '*', 'k', '1');
    await redis.xadd(b, '*', 'k', '1');
    const found = await scanStreams(
      redis,
      `test:stream-consumer:${RUN}:scan:*`,
      (key) => !key.endsWith(':shadow'),
    );
    expect(found).toEqual([a]);
  });
});
