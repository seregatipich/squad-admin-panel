export const LOG_SOURCES = [
  'bridge',
  'rcon',
  'log-ingest',
  'worker',
  'depot',
  'install',
  'api',
] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SOURCE_TO_CODE: Record<LogSource, string> = {
  bridge: 'B',
  rcon: 'R',
  'log-ingest': 'L',
  worker: 'W',
  depot: 'D',
  install: 'I',
  api: 'A',
};
const CODE_TO_SOURCE: Record<string, LogSource> = Object.fromEntries(
  Object.entries(SOURCE_TO_CODE).map(([k, v]) => [v, k as LogSource]),
) as Record<string, LogSource>;

const LEVEL_TO_CODE: Record<LogLevel, string> = { debug: 'D', info: 'I', warn: 'W', error: 'E' };
const CODE_TO_LEVEL: Record<string, LogLevel> = { D: 'debug', I: 'info', W: 'warn', E: 'error' };

export interface LogEntry {
  ts: number;
  source: LogSource;
  level: LogLevel;
  serverId?: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

export function sourceCode(s: LogSource): string {
  return SOURCE_TO_CODE[s];
}
export function sourceFromCode(c: string): LogSource {
  const s = CODE_TO_SOURCE[c];
  if (!s) throw new Error(`unknown source code: ${c}`);
  return s;
}

export function encodeLogEntry(e: Omit<LogEntry, 'ts'>): Record<string, string> {
  const out: Record<string, string> = {
    s: SOURCE_TO_CODE[e.source],
    l: LEVEL_TO_CODE[e.level],
    m: e.msg,
  };
  if (e.serverId) out.i = e.serverId;
  if (e.ctx && Object.keys(e.ctx).length > 0) out.c = JSON.stringify(e.ctx);
  return out;
}

export function decodeLogEntry(streamId: string, fields: Record<string, string>): LogEntry {
  const tsStr = streamId.split('-')[0] ?? '0';
  const ts = Number.parseInt(tsStr, 10);
  const sCode = fields.s ?? '';
  const lCode = fields.l ?? '';
  const source = CODE_TO_SOURCE[sCode];
  const level = CODE_TO_LEVEL[lCode];
  if (!source) throw new Error(`unknown source code: ${sCode}`);
  if (!level) throw new Error(`unknown level code: ${lCode}`);
  const out: LogEntry = { ts, source, level, msg: fields.m ?? '' };
  if (fields.i) out.serverId = fields.i;
  if (fields.c) {
    try {
      out.ctx = JSON.parse(fields.c) as Record<string, unknown>;
    } catch {
      out.ctx = { _raw: fields.c };
    }
  }
  return out;
}

export const PANEL_LOGS_STREAM = 'panel:logs';
export const PANEL_LOGS_MAXLEN = 100_000;
