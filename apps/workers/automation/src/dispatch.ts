import {
  DEDUP_KEY,
  DEDUP_TTL_SECONDS,
  type EventEnvelope,
  eventEnvelope,
  hasPluginPermission,
  STREAM_NAME,
} from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { PluginRegistration, PluginRegistry } from './registry.js';

/** Consumer group name every automation-worker process shares when reading event streams. */
export const DISPATCH_CONSUMER_GROUP = 'automation-dispatch:v1';
/** Hard ceiling on how long a single plugin invocation may run before it is abandoned. */
export const DEFAULT_PLUGIN_TIMEOUT_MS = 5_000;
/** How long a single XREADGROUP call blocks waiting for new entries. */
export const DEFAULT_BLOCK_MS = 1_000;
/** Max entries read per stream per XREADGROUP call. */
export const DEFAULT_BATCH_SIZE = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Parses the `envelope` field out of a raw XREADGROUP field array (as
 * produced by `apps/workers/log-ingest/src/publish.ts`'s `['envelope', json]`
 * XADD) and validates it against the shared `eventEnvelope` schema.
 * Returns `null` for a malformed or missing field instead of throwing, so a
 * single bad entry never aborts the consumer loop.
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

type PluginOutcome =
  | { ok: true }
  | { ok: false; reason: 'error'; error: unknown }
  | { ok: false; reason: 'timeout' };

/**
 * Runs `registration.handler.onEvent(envelope)` under a hard timeout: if the
 * handler throws synchronously, rejects asynchronously, or simply never
 * settles, this resolves with a `timeout`/`error` outcome after at most
 * `timeoutMs` so one broken plugin can never block or crash the dispatcher.
 * If the handler eventually settles after the timeout won the race, its
 * result is swallowed here (already-attached `.catch` prevents an unhandled
 * rejection).
 */
async function invokeWithTimeout(
  registration: PluginRegistration,
  envelope: EventEnvelope,
  timeoutMs: number,
): Promise<PluginOutcome> {
  const invocation: Promise<PluginOutcome> = Promise.resolve()
    .then(async () => {
      await registration.handler.onEvent(envelope);
      return { ok: true } as const;
    })
    .catch((error: unknown) => ({ ok: false, reason: 'error', error }) as const);

  const timeout: Promise<PluginOutcome> = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs).unref?.();
  });

  return Promise.race([invocation, timeout]);
}

export interface DispatchDeps {
  redis: Redis;
  registry: PluginRegistry;
  log: Logger;
  pluginTimeoutMs?: number;
  /**
   * Optional per-envelope hook run after plugin dispatch, inside the same
   * dedup-guarded block (so a completed run is not repeated for the same
   * event per consumer group). AUTO-1 (#72) wires the automation rule engine
   * here. A rejection leaves the entry unacked and without a dedup key, so the
   * reclaim sweep retries it — plugins then see the event again
   * (at-least-once).
   */
  onEnvelope?: (envelope: EventEnvelope) => Promise<void>;
}

export interface DispatchResult {
  delivered: number;
  deniedPermission: number;
  failed: number;
  timedOut: number;
}

/**
 * Dispatches a single validated envelope to every plugin subscribed to its
 * event kind. Each plugin invocation is isolated from every other:
 *
 * - A plugin without the `events:read` permission never runs — it is
 *   counted as `deniedPermission` and a warning is logged.
 * - A plugin without `events:payload` still runs, but is handed a copy of
 *   the envelope with `payload` redacted to `null`.
 * - A plugin whose handler throws or hangs past `pluginTimeoutMs` is caught
 *   by `invokeWithTimeout`, logged, and counted — it never affects delivery
 *   to any other subscriber, and never rejects this function.
 */
export async function dispatchEnvelope(
  deps: DispatchDeps,
  envelope: EventEnvelope,
): Promise<DispatchResult> {
  const { registry, log, pluginTimeoutMs = DEFAULT_PLUGIN_TIMEOUT_MS } = deps;
  const subscribers = registry.getSubscribers(envelope.type);
  const result: DispatchResult = { delivered: 0, deniedPermission: 0, failed: 0, timedOut: 0 };

  await Promise.all(
    subscribers.map(async (registration) => {
      const pluginId = registration.manifest.id;
      if (!hasPluginPermission(registration.manifest, 'events:read')) {
        result.deniedPermission++;
        log.warn(
          { pluginId, eventId: envelope.event_id },
          'plugin lacks events:read permission; dispatch skipped',
        );
        return;
      }

      const scoped: EventEnvelope = hasPluginPermission(registration.manifest, 'events:payload')
        ? envelope
        : { ...envelope, payload: null };

      const outcome = await invokeWithTimeout(registration, scoped, pluginTimeoutMs);
      if (outcome.ok) {
        result.delivered++;
        return;
      }
      if (outcome.reason === 'timeout') {
        result.timedOut++;
        log.error(
          { pluginId, eventId: envelope.event_id, timeoutMs: pluginTimeoutMs },
          'plugin handler timed out; skipped',
        );
        return;
      }
      result.failed++;
      log.error(
        {
          pluginId,
          eventId: envelope.event_id,
          err: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        },
        'plugin handler threw; skipped',
      );
    }),
  );

  return result;
}

/**
 * An entry idle (delivered but unacked) longer than this is reclaimed via
 * XAUTOCLAIM regardless of which consumer it was delivered to, so an entry
 * orphaned by a crash or left pending after a failed `onEnvelope` is retried
 * instead of sitting in the pending list forever (#841).
 */
export const DEFAULT_RECLAIM_MIN_IDLE_MS = 30_000;
/** Max entries claimed per stream per XAUTOCLAIM call. */
export const DEFAULT_RECLAIM_BATCH_SIZE = 50;
/** How often the pending-entry reclaim sweep runs (it also runs once at boot). */
export const DEFAULT_RECLAIM_INTERVAL_MS = 30_000;
/**
 * How often the stream set is re-discovered. Discovery is a keyspace-wide
 * `SCAN`, whose cost grows with every key in Redis (dedup keys included), so
 * it runs on a timer rather than on every poll (#843). A new game server's
 * stream is picked up within this interval; its consumer group starts at `0`,
 * so events published before discovery are still delivered.
 */
export const DEFAULT_STREAM_REFRESH_MS = 30_000;

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
 * Discovers every event stream plugins might care about: the shared
 * `events:global` stream plus every per-server `events:server:<id>` stream
 * currently present in Redis (discovered via `SCAN`, not a DB query, so the
 * automation worker has no database dependency). The dispatch loop calls it
 * every `streamRefreshMs`, so a newly started game server's stream is picked
 * up without a worker restart. Sidecar shadow streams are skipped (see
 * `LIVE_SERVER_STREAM`).
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

/**
 * Processes one stream entry with at-least-once semantics (#841), in the same
 * order as worker-discord's `consume.ts`:
 *
 * 1. a malformed entry is acked and dropped;
 * 2. an entry whose dedup key already exists was fully handled by an earlier
 *    delivery, so it is only acked;
 * 3. otherwise the plugins and the `onEnvelope` hook run, and only then is
 *    the dedup key set and the entry acked.
 *
 * Any rejection (an `onEnvelope` failure such as an unreachable database, or
 * a Redis error) propagates before the dedup key is written, so the entry
 * stays pending and the reclaim sweep retries it. A crash at any point before
 * the XACK likewise leaves it pending rather than silently dropped.
 */
async function processEntry(
  deps: DispatchDeps,
  stream: string,
  group: string,
  id: string,
  fields: string[],
): Promise<void> {
  const { redis, log } = deps;
  const envelope = parseStreamEnvelope(fields);
  if (!envelope) {
    log.warn({ stream, id }, 'malformed event entry; acking without dispatch');
    await redis.xack(stream, group, id);
    return;
  }

  // Consumer-side idempotency: the producer's dedup key is a no-op on the
  // first XADD (see publish.ts); this is where re-delivery is actually
  // caught, per-consumer-group.
  const dedupKey = DEDUP_KEY(group, envelope.event_id);
  if (await redis.get(dedupKey)) {
    await redis.xack(stream, group, id);
    return;
  }

  await dispatchEnvelope(deps, envelope);
  await deps.onEnvelope?.(envelope);
  await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  await redis.xack(stream, group, id);
}

async function processEntrySafely(
  deps: DispatchDeps,
  stream: string,
  group: string,
  id: string,
  fields: string[],
): Promise<void> {
  try {
    await processEntry(deps, stream, group, id, fields);
  } catch (err) {
    deps.log.error(
      { err: (err as Error).message, stream, id },
      'event entry processing failed; left pending for the reclaim sweep',
    );
  }
}

/**
 * Reclaims entries of `stream`/`group` idle longer than `minIdleMs` —
 * whichever (possibly dead) consumer they were delivered to — and processes
 * each like a freshly read entry.
 */
async function reclaimPendingEntries(
  deps: DispatchDeps,
  stream: string,
  group: string,
  consumer: string,
  minIdleMs: number,
  batchSize: number,
): Promise<void> {
  let claimed: [string, string[]][];
  try {
    const result = (await deps.redis.xautoclaim(
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
    if (!message.includes('NOGROUP')) deps.log.warn({ stream, err: message }, 'xautoclaim failed');
    return;
  }
  for (const [id, fields] of claimed) {
    await processEntrySafely(deps, stream, group, id, fields);
  }
}

export interface RunDispatchLoopOpts extends DispatchDeps {
  group?: string;
  consumer?: string;
  blockMs?: number;
  batchSize?: number;
  /** Entries idle longer than this are reclaimed from any consumer (see `reclaimPendingEntries`). */
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
}

/**
 * The automation worker's event-stream consumer: a consumer-group reader
 * (mirroring worker-discord's notify loop) that periodically discovers event
 * streams, reclaims stale pending entries, reads new envelopes, and dispatches
 * each to subscribed plugins via `dispatchEnvelope`.
 *
 * Nothing inside an iteration rejects this function: a failing discovery keeps
 * the previous stream set, a failing group creation skips that stream until
 * the next iteration retries it, a `NOGROUP` read error forgets every created
 * group so they are re-created (e.g. after Redis lost its data), and a failed
 * entry stays pending for the reclaim sweep (#844).
 */
export async function runDispatchLoop(opts: RunDispatchLoopOpts): Promise<void> {
  const {
    redis,
    group = DISPATCH_CONSUMER_GROUP,
    consumer = `automation-dispatch-${process.pid}`,
    blockMs = DEFAULT_BLOCK_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    reclaimMinIdleMs = DEFAULT_RECLAIM_MIN_IDLE_MS,
    reclaimBatchSize = DEFAULT_RECLAIM_BATCH_SIZE,
    reclaimIntervalMs = DEFAULT_RECLAIM_INTERVAL_MS,
    streamRefreshMs = DEFAULT_STREAM_REFRESH_MS,
    shouldStop,
    discoverStreams = discoverEventStreams,
    now = Date.now,
    log,
  } = opts;
  const deps: DispatchDeps = {
    redis,
    registry: opts.registry,
    log,
    pluginTimeoutMs: opts.pluginTimeoutMs,
    onEnvelope: opts.onEnvelope,
  };

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

    if (now() >= nextReclaimAt) {
      nextReclaimAt = now() + reclaimIntervalMs;
      for (const stream of readable) {
        await reclaimPendingEntries(
          deps,
          stream,
          group,
          consumer,
          reclaimMinIdleMs,
          reclaimBatchSize,
        );
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

      for (const [streamKey, entries] of res) {
        for (const [id, fields] of entries) {
          await processEntrySafely(deps, streamKey, group, id, fields);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // A known stream was deleted (its group went with it) and possibly
      // re-created by a later XADD: the multiplexed XREADGROUP then rejects
      // NOGROUP for every stream. Forget the cache so the next iteration
      // re-ensures each group; existing ones answer BUSYGROUP.
      log.error({ err: message }, 'dispatch poll iteration failed');
      if (message.includes('NOGROUP')) groupsCreated.clear();
      await sleep(1000);
    }
  }
}
