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
   * dedup-guarded block (so it fires at most once per event per consumer
   * group). AUTO-1 (#72) wires the automation rule engine here; a failure is
   * logged and swallowed so it never affects plugin delivery or acking.
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
 * automation worker has no database dependency). Called once per poll
 * iteration so a newly started game server's stream is picked up without a
 * worker restart. Sidecar shadow streams are skipped (see `LIVE_SERVER_STREAM`).
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

async function processEntry(
  deps: DispatchDeps,
  stream: string,
  group: string,
  id: string,
  fields: string[],
): Promise<void> {
  const { redis, log } = deps;
  try {
    const envelope = parseStreamEnvelope(fields);
    if (!envelope) {
      log.warn({ stream, id }, 'malformed event entry; acking without dispatch');
      await redis.xack(stream, group, id);
      return;
    }

    // Consumer-side idempotency: the producer's dedup key is a no-op on the
    // first XADD (see publish.ts); this is where re-delivery is actually
    // caught, per-consumer-group.
    const claimed = await redis.set(
      DEDUP_KEY(group, envelope.event_id),
      '1',
      'EX',
      DEDUP_TTL_SECONDS,
      'NX',
    );
    if (!claimed) {
      await redis.xack(stream, group, id);
      return;
    }

    await dispatchEnvelope(deps, envelope);
    if (deps.onEnvelope) {
      await deps.onEnvelope(envelope).catch((err: unknown) => {
        log.error({ err: (err as Error).message, stream, id }, 'automation onEnvelope hook failed');
      });
    }
    await redis.xack(stream, group, id);
  } catch (err) {
    log.error({ err: (err as Error).message, stream, id }, 'event entry processing failed');
  }
}

export interface RunDispatchLoopOpts extends DispatchDeps {
  group?: string;
  consumer?: string;
  blockMs?: number;
  batchSize?: number;
  /** Polled once per loop iteration; the loop returns once this is true. */
  shouldStop: () => boolean;
  /** Override stream discovery — used by tests to pin a fixed stream set. */
  discoverStreams?: (redis: Redis) => Promise<string[]>;
}

/**
 * The automation worker's event-stream consumer: a consumer-group reader
 * (mirroring worker-diag-flush's XREADGROUP loop) that discovers event
 * streams, reads envelopes, and dispatches each to subscribed plugins via
 * `dispatchEnvelope`. A failure processing one entry (bad JSON, a redis
 * blip) is logged and the loop continues — it never crashes the worker.
 */
export async function runDispatchLoop(opts: RunDispatchLoopOpts): Promise<void> {
  const {
    redis,
    group = DISPATCH_CONSUMER_GROUP,
    consumer = `automation-dispatch-${process.pid}`,
    blockMs = DEFAULT_BLOCK_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    shouldStop,
    discoverStreams = discoverEventStreams,
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
  const knownStreams = new Set<string>();
  let initialDiscovery = true;

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
      await ensureConsumerGroup(redis, stream, group, initialDiscovery ? '$' : '0');
      knownStreams.add(stream);
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
        ...streams,
        ...streams.map(() => '>'),
      )) as [string, [string, string[]][]][] | null;
      if (!res) continue;

      for (const [streamKey, entries] of res) {
        for (const [id, fields] of entries) {
          await processEntry(deps, streamKey, group, id, fields);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // A known stream was deleted (its group went with it) and possibly
      // re-created by a later XADD: the multiplexed XREADGROUP then rejects
      // NOGROUP for every stream. Forget the cache so the next iteration
      // re-ensures each group; existing ones answer BUSYGROUP.
      if (message.includes('NOGROUP')) {
        log.info({ err: message }, 'xreadgroup NOGROUP — re-creating consumer groups');
        knownStreams.clear();
        continue;
      }
      log.error({ err: message }, 'dispatch poll iteration failed');
      await sleep(1000);
    }
  }
}
