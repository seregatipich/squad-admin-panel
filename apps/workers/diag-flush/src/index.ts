import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiag, type Diag } from '@squad/diag';
import {
  createGracefulShutdownController,
  DIAG_STREAM_KEY,
  startHeartbeat,
} from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';
import { startJournaldForwarder } from './journald-bridge.js';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'worker-diag-flush' },
});

const COMPONENT = 'worker-diag-flush';

export async function emitStarted(diag: Diag): Promise<void> {
  await diag.emit({
    component: COMPONENT,
    kind: 'diag_flush.started',
    severity: 'info',
    message: 'diag-flush started',
    payload: { pid: process.pid },
  });
}

export async function emitStopped(diag: Diag, sig: NodeJS.Signals): Promise<void> {
  await diag.emit({
    component: COMPONENT,
    kind: 'diag_flush.stopped',
    severity: 'info',
    message: `diag-flush received ${sig}`,
    payload: { sig },
  });
}

const GROUP = 'diag-flush';
const CONSUMER = `diag-flush-${process.pid}`;
const BATCH_SIZE = Number.parseInt(process.env.DIAG_FLUSH_BATCH_SIZE ?? '100', 10);
const BLOCK_MS = 1000;
const STOPPED_EVENT_TIMEOUT_MS = 2_000;

/** Entries idle (read but unacked) longer than this are reclaimed by the sweep. */
const RECLAIM_MIN_IDLE_MS = 60_000;
/** How often the pending-entry sweep runs; it also runs once at startup. */
const RECLAIM_INTERVAL_MS = 30_000;

interface ParsedEntry {
  id: string;
  ts: string;
  component: string;
  severity: string;
  kind: string;
  serverId: string | null;
  actorPlayerId: string | null;
  requestId: string | null;
  message: string;
  payload: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The values `diagnostic_events_severity_chk` accepts. */
const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses one `diag:queue` entry into an insertable row, or returns `null` for
 * an entry Postgres would reject (#872): a missing field, an `id`/`server_id`/
 * `actor_player_id` that is not a UUID, an unparseable `ts`, a severity the
 * CHECK constraint refuses, or a payload that is not JSON. `ts` is normalised
 * to ISO-8601 UTC.
 */
export function parseEntry(fields: string[]): ParsedEntry | null {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === undefined || value === undefined) continue;
    map[key] = value;
  }
  const id = map.id;
  const ts = map.ts;
  const component = map.component;
  const severity = map.severity;
  const kind = map.kind;
  const message = map.message;
  if (!id || !ts || !component || !severity || !kind || !message) return null;
  const serverId = map.server_id ?? null;
  const actorPlayerId = map.actor_player_id ?? null;
  const payload = map.payload && map.payload.length > 0 ? map.payload : '{}';
  const tsMs = Date.parse(ts);
  if (
    !UUID.test(id) ||
    Number.isNaN(tsMs) ||
    !SEVERITIES.has(severity) ||
    (serverId !== null && !UUID.test(serverId)) ||
    (actorPlayerId !== null && !UUID.test(actorPlayerId)) ||
    !isJson(payload)
  ) {
    return null;
  }
  return {
    id,
    ts: new Date(tsMs).toISOString(),
    component,
    severity,
    kind,
    serverId,
    actorPlayerId,
    requestId: map.request_id ?? null,
    message,
    payload,
  };
}

/**
 * True for an error caused by the row itself — SQLSTATE class 22 (data
 * exception) or 23 (integrity violation, including a `ts` with no partition
 * and a `server_id` whose server is gone) — so retrying the row can never
 * succeed. Anything else (connection loss, timeouts) is transient.
 */
function isRowRejection(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}

async function insertRows(sql: postgres.Sql, rows: ParsedEntry[]): Promise<void> {
  const placeholders: string[] = [];
  const args: (string | null)[] = [];
  let i = 1;
  for (const row of rows) {
    placeholders.push(
      `($${i++},$${i++}::timestamptz,$${i++},$${i++},$${i++},$${i++}::uuid,$${i++}::uuid,$${i++},$${i++},$${i++}::jsonb)`,
    );
    args.push(
      row.id,
      row.ts,
      row.component,
      row.severity,
      row.kind,
      row.serverId,
      row.actorPlayerId,
      row.requestId,
      row.message,
      row.payload,
    );
  }
  const text = `INSERT INTO diagnostic_events (id, ts, component, severity, kind, server_id, actor_player_id, request_id, message, payload) VALUES ${placeholders.join(',')} ON CONFLICT (id, ts) DO NOTHING`;
  await sql.unsafe(text, args);
}

export interface FlushBatchOpts {
  sql: postgres.Sql;
  redis: Pick<Redis, 'xack'>;
  group: string;
  stream: string;
  entries: [string, string[]][];
}

/**
 * Inserts a batch of `diag:queue` entries, then acks all of them.
 *
 * Malformed entries are acked without an insert. When the multi-row INSERT
 * is rejected because of a row's data, the rows are retried one by one so a
 * single poison row (#872) is logged and dropped instead of stranding the
 * whole batch in the pending list. A transient failure (the database is
 * unreachable) rejects before the XACK, leaving the batch pending for
 * {@link reclaimPendingEntries}; a retry is harmless thanks to
 * `ON CONFLICT (id, ts) DO NOTHING`.
 */
export async function flushBatch(opts: FlushBatchOpts): Promise<void> {
  const { sql, redis, group, stream, entries } = opts;
  if (entries.length === 0) return;

  const validRows: ParsedEntry[] = [];
  const ackIds: string[] = [];
  for (const [streamId, fields] of entries) {
    ackIds.push(streamId);
    const parsed = parseEntry(fields);
    if (!parsed) {
      log.warn({ streamId, fields }, 'malformed diag entry; ACKing without insert');
      continue;
    }
    validRows.push(parsed);
  }

  if (validRows.length > 0) {
    try {
      await insertRows(sql, validRows);
    } catch (err) {
      if (!isRowRejection(err)) throw err;
      for (const row of validRows) {
        try {
          await insertRows(sql, [row]);
        } catch (rowErr) {
          if (!isRowRejection(rowErr)) throw rowErr;
          log.warn(
            { id: row.id, ts: row.ts, err: (rowErr as Error).message },
            'diag entry rejected by Postgres; ACKing without insert',
          );
        }
      }
    }
  }

  await redis.xack(stream, group, ...ackIds);
}

export interface ReclaimPendingOpts extends Omit<FlushBatchOpts, 'entries' | 'redis'> {
  redis: Pick<Redis, 'xack' | 'xautoclaim'>;
  consumer: string;
  minIdleMs: number;
  batchSize: number;
}

/**
 * Claims every entry of the group idle longer than `minIdleMs` — a batch
 * whose flush failed, or one read by a consumer that died — and flushes it
 * (#872). The loop only reads new entries (`>`), so without this sweep such
 * entries would stay in the pending list forever. Returns how many entries
 * were flushed; a flush failure rejects and leaves the rest pending.
 */
export async function reclaimPendingEntries(opts: ReclaimPendingOpts): Promise<number> {
  let cursor = '0-0';
  let flushed = 0;
  do {
    const [next, entries] = (await opts.redis.xautoclaim(
      opts.stream,
      opts.group,
      opts.consumer,
      opts.minIdleMs,
      cursor,
      'COUNT',
      opts.batchSize,
    )) as [string, [string, string[]][], string[]];
    await flushBatch({ ...opts, entries });
    flushed += entries.length;
    cursor = next;
  } while (cursor !== '0-0');
  return flushed;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const sql = postgres(databaseUrl, { max: 2 });
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error (will retry)'));
  redis.on('reconnecting', (delay: number) => log.info({ delay }, 'redis reconnecting'));

  let journald: ReturnType<typeof startJournaldForwarder> | null = null;
  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'diag-flush',
    statusFn: () =>
      journald && !journald.isRunning() ? 'degraded (journald forwarder down)' : 'ok',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const diag = createDiag({ redis, log });
  let stopped = false;
  let inflight: Promise<void> | null = null;
  const shutdown = createGracefulShutdownController({
    cleanup: async (sig) => {
      stopped = true;
      log.info({ sig }, 'shutdown');
      // With Redis unreachable the offline-queued XADD never settles; bound the
      // wait so the rest of the teardown still runs before Docker's SIGKILL.
      await Promise.race([
        emitStopped(diag, sig),
        new Promise<void>((resolve) => setTimeout(resolve, STOPPED_EVENT_TIMEOUT_MS).unref()),
      ]);
      stopHeartbeat();
      journald?.stop();
      await journald?.drain();
      if (inflight) {
        log.info('awaiting in-flight batch before teardown');
        await inflight.catch(() => undefined);
      }
      await sql.end({ timeout: 5 });
      await redis.quit().catch(() => undefined);
    },
    onError: (err) => log.error({ err: err.message }, 'shutdown failed'),
  });

  await redis.xgroup('CREATE', DIAG_STREAM_KEY, GROUP, '$', 'MKSTREAM').catch((err: Error) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });
  await emitStarted(diag);

  if (process.env.DIAG_JOURNALD_FORWARD !== 'false') {
    journald = startJournaldForwarder({
      redis,
      log,
      unitName: process.env.DIAG_JOURNALD_UNIT,
      since: process.env.DIAG_JOURNALD_SINCE,
    });
  }
  await shutdown.markReady();
  if (shutdown.isShutdownRequested()) return;

  log.info({ group: GROUP, consumer: CONSUMER, batchSize: BATCH_SIZE }, 'worker-diag-flush ready');

  let nextReclaimAt = 0;
  while (!stopped) {
    try {
      if (Date.now() >= nextReclaimAt) {
        nextReclaimAt = Date.now() + RECLAIM_INTERVAL_MS;
        const reclaimed = await reclaimPendingEntries({
          sql,
          redis,
          group: GROUP,
          stream: DIAG_STREAM_KEY,
          consumer: CONSUMER,
          minIdleMs: RECLAIM_MIN_IDLE_MS,
          batchSize: BATCH_SIZE,
        });
        if (reclaimed > 0) log.info({ reclaimed }, 'flushed reclaimed diag entries');
      }
      const res = (await redis.xreadgroup(
        'GROUP',
        GROUP,
        CONSUMER,
        'COUNT',
        BATCH_SIZE,
        'BLOCK',
        BLOCK_MS,
        'STREAMS',
        DIAG_STREAM_KEY,
        '>',
      )) as [string, [string, string[]][]][] | null;
      if (!res) continue;
      inflight = (async () => {
        for (const [, entries] of res) {
          await flushBatch({ sql, redis, group: GROUP, stream: DIAG_STREAM_KEY, entries });
        }
      })();
      try {
        await inflight;
      } finally {
        inflight = null;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'flush iteration failed');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function isMainEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch((err) => {
    log.fatal({ err: (err as Error).message }, 'fatal');
    process.exit(1);
  });
}
