import {
  DEDUP_KEY,
  DEDUP_TTL_SECONDS,
  type EventEnvelope,
  eventEnvelope,
  STREAM_NAME,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { mapEventToDiscordType } from './mapping.js';
import { type DeliveryResult, deliverEnvelope, type SenderDeps } from './sender.js';

/** Consumer group name every worker-discord process shares when reading event streams. */
export const NOTIFY_CONSUMER_GROUP = 'discord-notify:v1';
/** How long a single XREADGROUP call blocks waiting for new entries. */
export const DEFAULT_BLOCK_MS = 1_000;
/** Max entries read per stream per XREADGROUP call. */
export const DEFAULT_BATCH_SIZE = 50;
/**
 * An entry idle (undelivered/unacked) longer than this is reclaimed via
 * XAUTOCLAIM regardless of which consumer it was originally delivered to.
 * This is what makes a crash mid-send safe: `discord-notify-<pid>` changes on
 * every restart, so a plain XREADGROUP `>` read alone would never revisit an
 * entry still sitting in the previous process's pending list — it needs to
 * be reclaimed by the new consumer name instead.
 */
export const DEFAULT_RECLAIM_MIN_IDLE_MS = 30_000;
/** Max entries claimed per stream per XAUTOCLAIM call. */
export const DEFAULT_RECLAIM_BATCH_SIZE = 50;
/** How often the pending-entry reclaim sweep runs (it also runs once at boot). */
export const DEFAULT_RECLAIM_INTERVAL_MS = 30_000;
/**
 * How often the stream set is re-discovered. Discovery is a keyspace-wide
 * `SCAN` whose cost grows with every key in Redis, so it runs on a timer
 * rather than on every poll (#883). A new server's stream is picked up within
 * this interval; its consumer group starts at `0`, so nothing published before
 * discovery is missed.
 */
export const DEFAULT_STREAM_REFRESH_MS = 30_000;

/**
 * Parses the `envelope` field out of a raw XREADGROUP field array (as
 * produced by `apps/workers/log-ingest/src/publish.ts`'s `['envelope', json]`
 * XADD) and validates it against the shared `eventEnvelope` schema. Returns
 * `null` for a malformed or missing field instead of throwing, so a single
 * bad entry never aborts the consumer loop. Duplicated from
 * `apps/workers/automation/src/dispatch.ts` to keep this worker
 * self-contained (no cross-worker package dependency).
 */
export function parseStreamEnvelope(fields: string[]): EventEnvelope | null {
  const idx = fields.indexOf('envelope');
  const raw = idx >= 0 ? fields[idx + 1] : undefined;
  if (!raw) return null;
  try {
    const parsed = eventEnvelope.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Creates the consumer group for `stream` if it doesn't already exist (idempotent).
 *
 * @param startId Where a newly created group starts reading: `'$'` (default)
 *   skips the entries already in the stream, `'0'` delivers all of them.
 */
export async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
  startId: '$' | '0' = '$',
): Promise<void> {
  await redis.xgroup('CREATE', stream, group, startId, 'MKSTREAM').catch((err: Error) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });
}

/**
 * A live per-server stream is exactly `events:server:<id>`. The SCAN pattern
 * `events:server:*` also matches the RNSquadJS sidecar's shadow copy
 * `events:server:<id>:shadow`, which must never be consumed: it duplicates
 * events the live stream already carries under different `event_id`s (#16).
 */
const LIVE_SERVER_STREAM = /^events:server:[^:]+$/;

/**
 * Discovers every event stream this worker might care about: the shared
 * `events:global` stream plus every per-server `events:server:<id>` stream
 * currently present in Redis (via `SCAN`). The notify loop calls it every
 * `streamRefreshMs`, so a newly started game server's stream is picked up
 * without a restart.
 * Sidecar shadow streams are skipped (see `LIVE_SERVER_STREAM`).
 */
export async function discoverEventStreams(redis: Redis): Promise<string[]> {
  const streams = new Set<string>([STREAM_NAME.eventsGlobal()]);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'events:server:*', 'COUNT', 100);
    for (const key of keys) {
      if (LIVE_SERVER_STREAM.test(key)) streams.add(key);
    }
    cursor = next;
  } while (cursor !== '0');
  return [...streams];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export interface NotifyDeps extends SenderDeps {
  redis: Redis;
  log: Logger;
}

/**
 * Processes one stream entry: crash-safe, at-least-once delivery.
 *
 * Order matters for the no-loss/no-duplicate guarantee: the dedup key is
 * only SET *after* `deliverEnvelope` returns successfully, and XACK only
 * happens after that SET. If the process is killed at any point before the
 * XACK, the entry stays in the consumer group's pending list and is
 * redelivered on restart — at worst re-sending an embed that was in flight
 * when the kill happened (at-least-once), never silently dropping it. A
 * pre-existing dedup key (set by an earlier, already-acknowledged delivery
 * of the same `event_id`) short-circuits straight to XACK without invoking
 * `deliverEnvelope` at all, so a completed send is never re-posted.
 *
 * An event type with no Discord mapping is acked straight away without a
 * dedup key: nothing is sent for it, so a redelivery is harmless, and writing
 * a 24-hour key for every such event only grows the keyspace (#883).
 */
async function processEntry(
  deps: NotifyDeps,
  stream: string,
  group: string,
  id: string,
  fields: string[],
  onDelivery?: (result: DeliveryResult) => void,
): Promise<void> {
  const { redis, log } = deps;
  const envelope = parseStreamEnvelope(fields);
  if (!envelope) {
    log.warn({ stream, id }, 'malformed event entry; acking without delivery');
    await redis.xack(stream, group, id);
    return;
  }

  if (!mapEventToDiscordType(envelope.type)) {
    await redis.xack(stream, group, id);
    return;
  }

  const dedupKey = DEDUP_KEY(group, envelope.event_id);
  const alreadyDelivered = await redis.get(dedupKey);
  if (alreadyDelivered) {
    await redis.xack(stream, group, id);
    return;
  }

  const result = await deliverEnvelope(deps, envelope);
  onDelivery?.(result);
  await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  await redis.xack(stream, group, id);
}

/**
 * Reclaims entries in `stream`/`group` that have been idle longer than
 * `minIdleMs` — regardless of which (possibly now-dead) consumer they were
 * delivered to — and processes each exactly like a freshly-read entry. Used
 * both as a boot-time sweep (picks up anything orphaned by a prior crash)
 * and periodically during the loop (catches a consumer that dies mid-run).
 */
async function reclaimPendingEntries(
  deps: NotifyDeps,
  stream: string,
  group: string,
  consumer: string,
  minIdleMs: number,
  batchSize: number,
  onDelivery?: (result: DeliveryResult) => void,
): Promise<void> {
  const { redis, log } = deps;
  let claimed: [string, string[]][];
  try {
    const result = (await redis.xautoclaim(
      stream,
      group,
      consumer,
      minIdleMs,
      '0-0',
      'COUNT',
      batchSize,
    )) as [string, [string, string[]][], string[]];
    claimed = result?.[1] ?? [];
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes('NOGROUP')) {
      log.warn({ stream, err: message }, 'xautoclaim failed');
    }
    return;
  }
  for (const [id, fields] of claimed) {
    try {
      await processEntry(deps, stream, group, id, fields, onDelivery);
    } catch (err) {
      log.error(
        { err: (err as Error).message, stream, id },
        'reclaimed entry processing failed; left pending for the next reclaim sweep',
      );
    }
  }
}

export interface RunNotifyLoopOpts extends NotifyDeps {
  group?: string;
  consumer?: string;
  blockMs?: number;
  batchSize?: number;
  /** Entries idle longer than this are reclaimed from a dead consumer (see `reclaimPendingEntries`). */
  reclaimMinIdleMs?: number;
  reclaimBatchSize?: number;
  /** How often the reclaim sweep runs; it always runs on the first iteration. */
  reclaimIntervalMs?: number;
  /** How often the stream set is re-discovered; see `DEFAULT_STREAM_REFRESH_MS`. */
  streamRefreshMs?: number;
  /** Polled once per loop iteration; the loop returns once this is true. */
  shouldStop: () => boolean;
  /** Override stream discovery — used by tests to pin a fixed stream set. */
  discoverStreams?: (redis: Redis) => Promise<string[]>;
  /** Clock for the discovery and reclaim timers; injectable for tests. */
  now?: () => number;
  /** Invoked with the per-envelope delivery counters, e.g. for heartbeat status. */
  onDelivery?: (result: DeliveryResult) => void;
}

/**
 * The discord-notify worker's event-stream consumer: a consumer-group
 * reader (mirroring `apps/workers/automation/src/dispatch.ts`'s XREADGROUP
 * loop) that periodically discovers event streams and reclaims stale pending
 * entries, reads envelopes, and delivers each to subscribed Discord webhooks
 * via `deliverEnvelope`.
 *
 * Nothing inside an iteration rejects this function: a failing discovery
 * keeps the previous stream set, a failing group creation skips that stream
 * until the next iteration retries it, a `NOGROUP` read error forgets every
 * created group so they are re-created, and an entry whose processing throws
 * (e.g. the DB connection dropping) stays unacked for the reclaim sweep.
 */
export async function runNotifyLoop(opts: RunNotifyLoopOpts): Promise<void> {
  const {
    redis,
    group = NOTIFY_CONSUMER_GROUP,
    consumer = `discord-notify-${process.pid}`,
    blockMs = DEFAULT_BLOCK_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    reclaimMinIdleMs = DEFAULT_RECLAIM_MIN_IDLE_MS,
    reclaimBatchSize = DEFAULT_RECLAIM_BATCH_SIZE,
    reclaimIntervalMs = DEFAULT_RECLAIM_INTERVAL_MS,
    streamRefreshMs = DEFAULT_STREAM_REFRESH_MS,
    shouldStop,
    discoverStreams = discoverEventStreams,
    now = Date.now,
    onDelivery,
    log,
  } = opts;

  // Streams whose group this loop has ensured. A stream first seen on a later
  // iteration was created after the loop started — typically by the XADD of a
  // new server's first event — so its group starts at '0' and that event is
  // delivered; '$' would skip everything XADDed before discovery (#60,
  // finding 1291). Only the first discovery starts at '$', so a first start
  // against an existing install does not replay stream history. Redelivery of
  // an already-handled entry is harmless: consumers dedup by `event_id`.
  const groupsCreated = new Set<string>();
  let initialDiscovery = true;
  let streams: string[] = [];
  let nextDiscoveryAt = Number.NEGATIVE_INFINITY;
  let nextReclaimAt = Number.NEGATIVE_INFINITY;

  while (!shouldStop()) {
    if (now() >= nextDiscoveryAt) {
      try {
        streams = await discoverStreams(redis);
        nextDiscoveryAt = now() + streamRefreshMs;
      } catch (err) {
        log.error({ err: (err as Error).message }, 'event stream discovery failed');
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
            { err: (err as Error).message, stream },
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
    initialDiscovery = false;

    // Reclaim before reading new entries: an entry orphaned by a crashed
    // consumer (this process's own previous incarnation, or another replica)
    // is picked up here even though XREADGROUP `>` below would never
    // re-deliver it under a new consumer name.
    if (now() >= nextReclaimAt) {
      nextReclaimAt = now() + reclaimIntervalMs;
      for (const stream of readable) {
        await reclaimPendingEntries(
          opts,
          stream,
          group,
          consumer,
          reclaimMinIdleMs,
          reclaimBatchSize,
          onDelivery,
        );
      }
    }

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

      for (const [streamKey, entries] of res) {
        for (const [id, fields] of entries) {
          try {
            await processEntry(opts, streamKey, group, id, fields, onDelivery);
          } catch (err) {
            log.error(
              { err: (err as Error).message, stream: streamKey, id },
              'event entry processing failed; left pending for redelivery',
            );
          }
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // A known stream was deleted (its group went with it) and possibly
      // re-created by a later XADD: the multiplexed XREADGROUP then rejects
      // NOGROUP for every stream. Forget the cache so the next iteration
      // re-ensures each group; existing ones answer BUSYGROUP.
      log.error({ err: message }, 'notify poll iteration failed');
      if (message.includes('NOGROUP')) groupsCreated.clear();
      await sleep(1000);
    }
  }
}
