import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { auditLog } from '@squad/db';
import {
  decodeLogEntry,
  HOST_METRICS_STREAM,
  type LogEntry,
  PANEL_LOGS_STREAM,
  unpackHostMetrics,
} from '@squad/shared-config';
import { gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const SECTION = (label: string): string => `\n===== ${label} =====\n`;
const LEVEL_3: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };
const AUDIT_CAP = 50_000;

interface ServerRef {
  id: string;
  display_name: string;
}

function fmtIso(ts: number): string {
  return new Date(ts).toISOString();
}

function fmtEntry(e: LogEntry, serverName?: string): string {
  const ctx = e.ctx ? `  ctx=${JSON.stringify(e.ctx)}` : '';
  const tag = serverName ? ` [${serverName}]` : '';
  return `${fmtIso(e.ts)} ${LEVEL_3[e.level] ?? '???'} [${e.source}]${tag} ${e.msg}${ctx}\n`;
}

async function* iterateLogs(
  app: FastifyInstance,
  predicate: (e: LogEntry) => boolean,
): AsyncGenerator<LogEntry> {
  let cursor = '-';
  for (;;) {
    const start = cursor === '-' ? '-' : `(${cursor}`;
    const items = (await app.redis.xrange(PANEL_LOGS_STREAM, start, '+', 'COUNT', 1000)) as Array<
      [string, string[]]
    >;
    if (items.length === 0) return;
    for (const [id, fields] of items) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i] ?? ''] = fields[i + 1] ?? '';
      try {
        const e = decodeLogEntry(id, obj);
        if (predicate(e)) yield e;
      } catch {
        // skip malformed
      }
    }
    const last = items[items.length - 1];
    if (!last) return;
    if (last[0] === cursor) return;
    cursor = last[0];
  }
}

async function tailContainerOneShot(
  app: FastifyInstance,
  name: string,
  deadlineMs = 1500,
): Promise<string> {
  const client = app.makeBridgeClient();
  const collected: string[] = [];
  const follow = client
    .containerLogsFollow({ name, tail: 5000 }, (frame) => {
      if (frame.stream !== 'stdout') return;
      const text = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
      collected.push(text);
    })
    .catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  await Promise.race([follow, deadline]);
  if (timer) clearTimeout(timer);
  await client.close().catch(() => undefined);
  return collected.join('');
}

export async function* exportBundle(
  app: FastifyInstance,
  servers: ServerRef[],
): AsyncGenerator<string> {
  yield `===== EXPORT panel-logs ${new Date().toISOString()} =====\n`;

  yield SECTION('BRIDGE');
  for await (const e of iterateLogs(app, (x) => x.source === 'bridge')) yield fmtEntry(e);

  for (const s of servers) {
    yield SECTION(`RCON server "${s.display_name}" (${s.id})`);
    for await (const e of iterateLogs(app, (x) => x.source === 'rcon' && x.serverId === s.id)) {
      yield fmtEntry(e, s.display_name);
    }
  }

  for (const s of servers) {
    yield SECTION(`LOG-INGEST server "${s.display_name}" (${s.id})`);
    for await (const e of iterateLogs(
      app,
      (x) => x.source === 'log-ingest' && x.serverId === s.id,
    )) {
      yield fmtEntry(e, s.display_name);
    }
  }

  yield SECTION('WORKERS');
  for await (const e of iterateLogs(app, (x) => x.source === 'worker')) yield fmtEntry(e);

  yield SECTION('DEPOT / INSTALL');
  for await (const e of iterateLogs(app, (x) => x.source === 'depot' || x.source === 'install')) {
    yield fmtEntry(e);
  }

  yield SECTION('API');
  for await (const e of iterateLogs(app, (x) => x.source === 'api')) yield fmtEntry(e);

  yield SECTION('HOST METRICS 24h (CSV)');
  yield 'ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15\n';
  const metricsCutoff = `${Date.now() - 86_400_000}-0`;
  const ms = (await app.redis.xrange(HOST_METRICS_STREAM, metricsCutoff, '+')) as Array<
    [string, string[]]
  >;
  for (const [id, fields] of ms) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i] ?? ''] = fields[i + 1] ?? '';
    if (!obj.v) continue;
    try {
      const m = unpackHostMetrics(JSON.parse(obj.v) as number[]);
      const ts = fmtIso(Number.parseInt(id.split('-')[0] ?? '0', 10));
      yield `${ts},${m.cpu_percent.toFixed(2)},${m.ram_used_bytes},${m.disk_used_bytes},${m.net_rx_bytes_per_sec},${m.net_tx_bytes_per_sec},${m.load_avg_1m.toFixed(2)},${m.load_avg_5m.toFixed(2)},${m.load_avg_15m.toFixed(2)}\n`;
    } catch {
      // skip malformed sample
    }
  }

  yield SECTION('AUDIT (last 24h)');
  const cutoffDate = new Date(Date.now() - 86_400_000);
  const auditRows = await app.db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorKind: auditLog.actorKind,
      actionType: auditLog.actionType,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      statusCode: auditLog.statusCode,
    })
    .from(auditLog)
    .where(gt(auditLog.createdAt, cutoffDate))
    .orderBy(auditLog.id)
    .limit(AUDIT_CAP);
  for (const row of auditRows) {
    yield `${row.createdAt.toISOString()} ${row.actorKind} ${row.actionType} ${row.targetType ?? ''}/${row.targetId ?? ''} ${row.statusCode ?? ''}\n`;
  }
  if (auditRows.length === AUDIT_CAP) {
    yield `[audit section truncated at ${AUDIT_CAP} rows; query Postgres directly for the full record]\n`;
  }

  for (const s of servers) {
    yield SECTION(`SQUAD GAME LOGS server "${s.display_name}" (${s.id})`);
    try {
      yield await tailContainerOneShot(app, `squad-${s.id}`);
    } catch (err) {
      yield `[squad-${s.id}: ${(err as Error).message}]\n`;
    }
  }
}

export function streamBundle(app: FastifyInstance, servers: ServerRef[]): NodeJS.ReadableStream {
  const gen = exportBundle(app, servers);
  const src = Readable.from(gen, { objectMode: false });
  return src.pipe(createGzip());
}
