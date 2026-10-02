import { DEDUP_KEY, DEDUP_TTL_SECONDS } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

/** How long one XREADGROUP call blocks waiting for new entries. */
export const DEFAULT_BLOCK_MS = 1_000;
/** Max entries read per stream per XREADGROUP call. */
export const DEFAULT_BATCH_SIZE = 50;
/**
 * An entry delivered but unacked for longer than this is reclaimed with
 * XAUTOCLAIM, whichever (possibly dead) consumer it was delivered to, so an
 * entry orphaned by a crash or left pending after a failed handler is retried.
 */
export const DEFAULT_RECLAIM_MIN_IDLE_MS = 30_000;
export const DEFAULT_RECLAIM_BATCH_SIZE = 50;
export const DEFAULT_RECLAIM_INTERVAL_MS = 30_000;
/** How often the stream set is re-discovered (a keyspace `SCAN`, so not on every read). */
export const DEFAULT_STREAM_REFRESH_MS = 30_000;

export interface StreamConsumerOptions {
  /**
   * A connection of its own: XREADGROUP blocks, and on a shared ioredis
   * connection every other command would queue behind the block.
   */
  redis: Redis;
  log: Pick<Logger, 'warn' | 'error'>;
  group: string;
  consumer: string;
  /** Streams to read, re-evaluated every `streamRefreshMs`. */
  discoverStreams: (redis: Redis) => Promise<string[]>;
  /**
   * Processes one entry. A rejection leaves the entry unacked, so the reclaim
   * sweep retries it; resolving acks it.
   */
  handle: (stream: string, id: string, fields: string[]) => Promise<void>;
  /**
   * Skips an entry an earlier delivery already handled, by a dedup key per
   * entry. For handlers that are not idempotent themselves.
   */
  dedupeByEntry?: boolean;
  /** Polled once per loop iteration; the loop returns once this is true. */
  shouldStop: () => boolean;
  blockMs?: number;
  batchSize?: number;
  reclaimMinIdleMs?: number;
  reclaimBatchSize?: number;
  reclaimIntervalMs?: number;
  streamRefreshMs?: number;
  /** Clock of the discovery and reclaim timers; injectable for tests. */
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Creates the consumer group for `stream` if it does not exist.
 *
 * @param startId - where a new group starts: `'$'` skips what the stream already holds, `'0'` delivers all of it
 */
async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
  startId: '$' | '0',
): Promise<void> {
  await redis.xgroup('CREATE', stream, group, startId, 'MKSTREAM').catch((err: Error) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });
}

/**
 * Finds every key matching `pattern` with `SCAN`, keeping those `accept` takes.
 * Discovery is by key scan, not a database query, so a stream that appears
 * after the worker started is picked up on the next refresh.
 *
 * @param redis - the connection to scan with
 * @param pattern - a `MATCH` glob such as `events:server:*`
 * @param accept - filter for keys the glob over-matches
 * @returns the accepted keys
 */
export async function scanStreams(
  redis: Redis,
  pattern: string,
  accept: (key: string) => boolean = () => true,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    for (const key of keys) if (accept(key)) found.push(key);
    cursor = next;
  } while (cursor !== '0');
  return found;
}

async function processEntry(
  opts: StreamConsumerOptions,
  stream: string,
  id: string,
  fields: string[],
): Promise<void> {
  const { redis, group } = opts;
  const dedupKey = opts.dedupeByEntry ? DEDUP_KEY(group, `${stream}:${id}`) : null;
  if (dedupKey && (await redis.get(dedupKey))) {
    await redis.xack(stream, group, id);
    return;
  }
  await opts.handle(stream, id, fields);
  if (dedupKey) await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  await redis.xack(stream, group, id);
}

async function processEntrySafely(
  opts: StreamConsumerOptions,
  stream: string,
  id: string,
  fields: string[],
): Promise<void> {
  try {
    await processEntry(opts, stream, id, fields);
  } catch (err) {
    opts.log.error(
      { err: (err as Error).message, stream, id, group: opts.group },
      'stream entry processing failed; left pending for the reclaim sweep',
    );
  }
}

async function reclaimPendingEntries(
  opts: StreamConsumerOptions,
  stream: string,
  minIdleMs: number,
  batchSize: number,
): Promise<void> {
  let claimed: [string, string[]][];
  try {
    const result = (await opts.redis.xautoclaim(
      stream,
      opts.group,
      opts.consumer,
      minIdleMs,
      '0-0',
      'COUNT',
      batchSize,
    )) as [string, [string, string[]][], string[]];
    claimed = result?.[1] ?? [];
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes('NOGROUP')) {
      opts.log.warn({ stream, group: opts.group, err: message }, 'xautoclaim failed');
    }
    return;
  }
  for (const [id, fields] of claimed) await processEntrySafely(opts, stream, id, fields);
}

/**
 * A consumer-group reader over a changing set of Redis streams: discovers the
 * streams, creates the group on each, reclaims stale pending entries, reads new
 * ones and hands each to `handle`. Shaped like worker-automation's dispatch
 * loop, which workers cannot share because they do not depend on each other.
 *
 * Nothing inside an iteration rejects this function: a failing discovery keeps
 * the previous stream set, a failing group creation skips that stream until the
 * next iteration, a `NOGROUP` read error forgets every created group so they are
 * re-created (Redis lost its data), and a failing entry stays pending.
 *
 * The first discovery creates groups at `'$'`, so a first start against an
 * existing install does not replay stream history; a stream first seen later
 * starts at `'0'`, so the entry that created it is delivered.
 */
export async function runStreamConsumer(opts: StreamConsumerOptions): Promise<void> {
  const {
    redis,
    group,
    consumer,
    log,
    shouldStop,
    blockMs = DEFAULT_BLOCK_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    reclaimMinIdleMs = DEFAULT_RECLAIM_MIN_IDLE_MS,
    reclaimBatchSize = DEFAULT_RECLAIM_BATCH_SIZE,
    reclaimIntervalMs = DEFAULT_RECLAIM_INTERVAL_MS,
    streamRefreshMs = DEFAULT_STREAM_REFRESH_MS,
    now = Date.now,
  } = opts;

  const groupsCreated = new Set<string>();
  let initialDiscovery = true;
  let streams: string[] = [];
  let nextDiscoveryAt = Number.NEGATIVE_INFINITY;
  let nextReclaimAt = Number.NEGATIVE_INFINITY;

  while (!shouldStop()) {
    if (now() >= nextDiscoveryAt) {
      try {
        streams = await opts.discoverStreams(redis);
        nextDiscoveryAt = now() + streamRefreshMs;
      } catch (err) {
        log.error({ err: (err as Error).message, group }, 'stream discovery failed');
        if (streams.length === 0) {
          await sleep(1000);
          continue;
        }
      }
    }

    const readable: string[] = [];
    for (const stream of streams) {
      if (!groupsCreated.has(stream)) {
        try {
          await ensureConsumerGroup(redis, stream, group, initialDiscovery ? '$' : '0');
          groupsCreated.add(stream);
        } catch (err) {
          log.error(
            { err: (err as Error).message, stream, group },
            'consumer group creation failed; stream skipped until the next iteration',
          );
          continue;
        }
      }
      readable.push(stream);
    }
    if (readable.length === 0) {
      await sleep(blockMs);
      continue;
    }

    if (now() >= nextReclaimAt) {
      nextReclaimAt = now() + reclaimIntervalMs;
      for (const stream of readable) {
        await reclaimPendingEntries(opts, stream, reclaimMinIdleMs, reclaimBatchSize);
      }
    }
    initialDiscovery = false;

    try {
      const res = (await redis.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        batchSize,
        'BLOCK',
        blockMs,
        'STREAMS',
        ...readable,
        ...readable.map(() => '>'),
      )) as [string, [string, string[]][]][] | null;
      if (!res) continue;
      for (const [stream, entries] of res) {
        for (const [id, fields] of entries) await processEntrySafely(opts, stream, id, fields);
      }
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, group }, 'stream poll iteration failed');
      if (message.includes('NOGROUP')) groupsCreated.clear();
      await sleep(1000);
    }
  }
}
