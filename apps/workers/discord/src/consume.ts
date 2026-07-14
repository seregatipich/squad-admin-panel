import {
  DEDUP_KEY,
  DEDUP_TTL_SECONDS,
  type EventEnvelope,
  eventEnvelope,
  STREAM_NAME,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
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

/** Creates the consumer group for `stream` if it doesn't already exist (idempotent). */
export async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
): Promise<void> {
  await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM').catch((err: Error) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });
}

/**
 * Discovers every event stream this worker might care about: the shared
 * `events:global` stream plus every per-server `events:server:<id>` stream
 * currently present in Redis (via `SCAN`). Called once per poll iteration so
 * a newly started game server's stream is picked up without a restart.
 */
export async function discoverEventStreams(redis: Redis): Promise<string[]> {
  const streams = new Set<string>([STREAM_NAME.eventsGlobal()]);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'events:server:*', 'COUNT', 100);
    for (const key of keys) streams.add(key);
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
  /** Polled once per loop iteration; the loop returns once this is true. */
  shouldStop: () => boolean;
  /** Override stream discovery — used by tests to pin a fixed stream set. */
  discoverStreams?: (redis: Redis) => Promise<string[]>;
  /** Invoked with the per-envelope delivery counters, e.g. for heartbeat status. */
  onDelivery?: (result: DeliveryResult) => void;
}

/**
 * The discord-notify worker's event-stream consumer: a consumer-group
 * reader (mirroring `apps/workers/automation/src/dispatch.ts`'s XREADGROUP
 * loop) that discovers event streams, reads envelopes, and delivers each to
 * subscribed Discord webhooks via `deliverEnvelope`. A failure processing
 * one entry (bad JSON, a Redis blip) is logged and the loop continues — it
 * never crashes the worker. Errors thrown by `deliverEnvelope` itself (e.g.
 * the DB connection dropping) propagate out of `processEntry` and leave the
 * entry unacked for redelivery, which the outer catch here logs and retries
 * on the next iteration instead of throwing out of the loop.
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
    shouldStop,
    discoverStreams = discoverEventStreams,
    onDelivery,
    log,
  } = opts;

  const knownStreams = new Set<string>();

  while (!shouldStop()) {
    let streams: string[];
    try {
      streams = await discoverStreams(redis);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'event stream discovery failed');
      await sleep(1000);
      continue;
    }
    if (streams.length === 0) {
      await sleep(blockMs);
      continue;
    }

    for (const stream of streams) {
      if (knownStreams.has(stream)) continue;
      await ensureConsumerGroup(redis, stream, group);
      knownStreams.add(stream);
    }

    // Reclaim before reading new entries: an entry orphaned by a crashed
    // consumer (this process's own previous incarnation, or another replica)
    // is picked up here even though XREADGROUP `>` below would never
    // re-deliver it under a new consumer name.
    for (const stream of streams) {
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
        ...streams,
        ...streams.map(() => '>'),
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
      log.error({ err: (err as Error).message }, 'notify poll iteration failed');
      await sleep(1000);
    }
  }
}
