import type { DatabaseClient } from '@squad/db';
import { type EventEnvelope, eventEnvelope, STREAM_NAME } from '@squad/shared-types';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { runStreamConsumer, scanStreams } from '../stream-consumer.js';
import type { AlertSinkDeps } from './sink.js';
import { type AlertRuleCache, handleAlertEvent } from './store.js';

/**
 * Consumer group of the alert reader of the event streams; separate from the
 * dedup group `handleAlertEvent` keys its per-event claim on.
 */
export const ALERT_STREAM_GROUP = 'log-ingest-alert-stream:v1';

/**
 * Event kinds worker-rcon publishes to the event streams and nothing else
 * evaluates, so a `custom` alert rule on one of them can only fire from here
 * (#27). The log-derived kinds are evaluated inline by the log tail, where
 * `admin_login_new_ip` must run before the connect IP is recorded; the kinds
 * with their own alert producers (`bansync.failed`, `externalban.matched`,
 * `alt.ban_evasion_suspected`, `reports.spam_flagged`, the seed notifications)
 * raise their alerts directly, so evaluating them here would alert twice.
 */
export const STREAM_ALERT_KINDS: ReadonlySet<string> = new Set([
  'rcon.connected',
  'rcon.disconnected',
  'rcon.players_polled',
  'performance.degraded',
  'squad.created',
  'squad.leader_changed',
  'squad.disbanded',
]);

export interface AlertStreamDeps {
  db: DatabaseClient;
  /** The worker's shared connection: dedup claims, rule counters and the live-bus publish. */
  redis: Redis;
  rules: Pick<AlertRuleCache, 'enabledRules'>;
  sink: AlertSinkDeps;
  log: Pick<Logger, 'warn' | 'error'>;
}

/** Parses the `envelope` field of a raw stream entry; `null` for a missing or invalid one. */
function readEnvelope(fields: string[]): EventEnvelope | null {
  const at = fields.indexOf('envelope');
  const raw = at < 0 ? undefined : fields[at + 1];
  if (!raw) return null;
  try {
    const parsed = eventEnvelope.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates the alert rules against one event read from an event stream.
 * Events outside {@link STREAM_ALERT_KINDS} are skipped. A database or Redis
 * failure rejects, so the entry stays pending and is retried; the per-event
 * claim in `handleAlertEvent` makes the retry safe.
 *
 * @param deps - database, Redis, the rule cache and the delivery transports
 * @param fields - the raw entry fields
 */
export async function handleAlertStreamEntry(
  deps: AlertStreamDeps,
  fields: string[],
): Promise<void> {
  const envelope = readEnvelope(fields);
  if (!envelope) {
    deps.log.warn({}, 'malformed event entry skipped by the alert stream reader');
    return;
  }
  if (!STREAM_ALERT_KINDS.has(envelope.type)) return;
  await handleAlertEvent(deps.db, deps.redis, deps.rules, envelope, deps.sink);
}

/** `events:global` plus every live per-server stream; the sidecar's `:shadow` copies duplicate events. */
const LIVE_SERVER_STREAM = /^events:server:[^:]+$/;

/**
 * Runs the alert reader of the event streams until `shouldStop` returns true.
 *
 * @param deps - see {@link AlertStreamDeps}
 * @param blocking - a connection dedicated to the blocking reads
 * @param shouldStop - polled once per read
 */
export function runAlertStreamConsumer(
  deps: AlertStreamDeps,
  blocking: Redis,
  shouldStop: () => boolean,
): Promise<void> {
  return runStreamConsumer({
    redis: blocking,
    log: deps.log,
    group: ALERT_STREAM_GROUP,
    consumer: `log-ingest-alerts-${process.pid}`,
    discoverStreams: async (redis) => [
      STREAM_NAME.eventsGlobal(),
      ...(await scanStreams(redis, 'events:server:*', (key) => LIVE_SERVER_STREAM.test(key))),
    ],
    handle: (_stream, _id, fields) => handleAlertStreamEntry(deps, fields),
    shouldStop,
  });
}
