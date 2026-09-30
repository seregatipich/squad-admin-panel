import { pipeline, Readable } from 'node:stream';
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

/** Pages through the whole `panel:logs` stream, oldest first, skipping malformed entries. */
async function* iterateLogs(app: FastifyInstance): AsyncGenerator<LogEntry> {
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
        yield decodeLogEntry(id, obj);
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

/** Formatted `panel:logs` lines, grouped by the export section they belong to. */
interface LogSections {
  bridge: string[];
  rconByServer: Map<string, string[]>;
  ingestByServer: Map<string, string[]>;
  workers: string[];
  depotInstall: string[];
  api: string[];
}

/**
 * Reads `panel:logs` exactly once and sorts every entry into its export
 * section (#36): one scan per section used to cost 2N+4 full passes of the
 * stream for N servers. Memory is bounded by the stream's `MAXLEN`
 * (`PANEL_LOGS_MAXLEN`), the same data the per-section passes already
 * transferred. RCON/log-ingest entries for a server not in `servers`, and
 * sources the export has no section for, are dropped as before.
 */
async function collectLogSections(
  app: FastifyInstance,
  servers: readonly ServerRef[],
): Promise<LogSections> {
  const sections: LogSections = {
    bridge: [],
    rconByServer: new Map(servers.map((s) => [s.id, []])),
    ingestByServer: new Map(servers.map((s) => [s.id, []])),
    workers: [],
    depotInstall: [],
    api: [],
  };
  const nameById = new Map(servers.map((s) => [s.id, s.display_name]));
  for await (const e of iterateLogs(app)) {
    switch (e.source) {
      case 'bridge':
        sections.bridge.push(fmtEntry(e));
        break;
      case 'rcon':
      case 'log-ingest': {
        const name = e.serverId ? nameById.get(e.serverId) : undefined;
        if (!e.serverId || name === undefined) break;
        const target = e.source === 'rcon' ? sections.rconByServer : sections.ingestByServer;
        target.get(e.serverId)?.push(fmtEntry(e, name));
        break;
      }
      case 'worker':
        sections.workers.push(fmtEntry(e));
        break;
      case 'depot':
      case 'install':
        sections.depotInstall.push(fmtEntry(e));
        break;
      case 'api':
        sections.api.push(fmtEntry(e));
        break;
      default:
        break;
    }
  }
  return sections;
}

export async function* exportBundle(
  app: FastifyInstance,
  servers: ServerRef[],
): AsyncGenerator<string> {
  yield `===== EXPORT panel-logs ${new Date().toISOString()} =====\n`;

  const logs = await collectLogSections(app, servers);

  yield SECTION('BRIDGE');
  yield* logs.bridge;

  for (const s of servers) {
    yield SECTION(`RCON server "${s.display_name}" (${s.id})`);
    yield* logs.rconByServer.get(s.id) ?? [];
  }

  for (const s of servers) {
    yield SECTION(`LOG-INGEST server "${s.display_name}" (${s.id})`);
    yield* logs.ingestByServer.get(s.id) ?? [];
  }

  yield SECTION('WORKERS');
  yield* logs.workers;

  yield SECTION('DEPOT / INSTALL');
  yield* logs.depotInstall;

  yield SECTION('API');
  yield* logs.api;

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

/**
 * Gzip-compressed stream of {@link exportBundle} for `GET /api/v1/logs/export`.
 *
 * Uses `stream.pipeline`, not `.pipe()`: a failure inside the export (Redis or
 * Postgres down mid-read) must destroy the returned gzip stream so Fastify
 * aborts the response. With `.pipe()` the source's `error` event had no
 * listener, became an `uncaughtException` and took down the API process, and
 * the gzip stream never ended (#36).
 *
 * @returns The gzip stream; it errors (and is destroyed) if the export fails.
 */
export function streamBundle(app: FastifyInstance, servers: ServerRef[]): NodeJS.ReadableStream {
  const gz = createGzip();
  pipeline(Readable.from(exportBundle(app, servers), { objectMode: false }), gz, (err) => {
    if (err) app.log.warn({ err }, 'log export failed');
  });
  return gz;
}
