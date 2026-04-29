import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDiag, type Diag } from '@squad/diag';
import { DIAG_STREAM_KEY, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino from 'pino';
import postgres from 'postgres';

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

interface ParsedEntry {
  id: string;
  ts: string;
  component: string;
  severity: string;
  kind: string;
  serverId: string | null;
  actorSteamId64: string | null;
  requestId: string | null;
  message: string;
  payload: string;
}

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
  const payload = map.payload && map.payload.length > 0 ? map.payload : '{}';
  return {
    id,
    ts,
    component,
    severity,
    kind,
    serverId: map.server_id ?? null,
    actorSteamId64: map.actor_steam_id64 ?? null,
    requestId: map.request_id ?? null,
    message,
    payload,
  };
}

export interface FlushBatchOpts {
  sql: postgres.Sql;
  redis: Pick<Redis, 'xack'>;
  group: string;
  stream: string;
  entries: [string, string[]][];
}

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
    const placeholders: string[] = [];
    const args: (string | null)[] = [];
    let i = 1;
    for (const row of validRows) {
      placeholders.push(
        `($${i++},$${i++}::timestamptz,$${i++},$${i++},$${i++},$${i++}::uuid,$${i++}::bigint,$${i++},$${i++},$${i++}::jsonb)`,
      );
      args.push(
        row.id,
        row.ts,
        row.component,
        row.severity,
        row.kind,
        row.serverId,
        row.actorSteamId64,
        row.requestId,
        row.message,
        row.payload,
      );
    }
    const text = `INSERT INTO diagnostic_events (id, ts, component, severity, kind, server_id, actor_steam_id64, request_id, message, payload) VALUES ${placeholders.join(',')} ON CONFLICT (id, ts) DO NOTHING`;
    await sql.unsafe(text, args);
  }

  await redis.xack(stream, group, ...ackIds);
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

  await redis.xgroup('CREATE', DIAG_STREAM_KEY, GROUP, '$', 'MKSTREAM').catch((err: Error) => {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  });

  const stopHeartbeat = startHeartbeat({
    redis,
    name: 'diag-flush',
    statusFn: () => 'ok',
    onError: (err) => log.warn({ err: err.message }, 'heartbeat publish failed'),
  });

  const diag = createDiag({ redis, log });
  await emitStarted(diag);

  let stopped = false;
  let inflight: Promise<void> | null = null;
  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopped = true;
    await emitStopped(diag, sig);
    stopHeartbeat();
    if (inflight) {
      log.info('awaiting in-flight batch before teardown');
      await inflight.catch(() => undefined);
    }
    await sql.end({ timeout: 5 });
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  log.info({ group: GROUP, consumer: CONSUMER, batchSize: BATCH_SIZE }, 'worker-diag-flush ready');

  while (!stopped) {
    try {
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
