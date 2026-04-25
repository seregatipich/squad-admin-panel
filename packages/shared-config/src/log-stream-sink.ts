import { Writable } from 'node:stream';
import {
  encodeLogEntry,
  type LogLevel,
  type LogSource,
  PANEL_LOGS_MAXLEN,
  PANEL_LOGS_STREAM,
} from './log-stream.js';

interface RedisLike {
  xadd(...args: unknown[]): Promise<string | null>;
}

export interface RedisSinkOptions {
  redis: RedisLike;
  defaultSource: LogSource;
  minLevel?: LogLevel;
}

const PINO_TO_LEVEL: Array<[number, LogLevel]> = [
  [60, 'error'],
  [50, 'error'],
  [40, 'warn'],
  [30, 'info'],
  [20, 'debug'],
];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function pinoLevelToLog(n: number): LogLevel {
  for (const [k, v] of PINO_TO_LEVEL) if (n >= k) return v;
  return 'debug';
}

function isLogSource(s: unknown): s is LogSource {
  return (
    s === 'bridge' ||
    s === 'rcon' ||
    s === 'log-ingest' ||
    s === 'worker' ||
    s === 'depot' ||
    s === 'install' ||
    s === 'api'
  );
}

const PINO_META_KEYS = new Set([
  'level',
  'msg',
  'time',
  'pid',
  'hostname',
  'src',
  'serverId',
  'service',
  'v',
  'name',
  'reqId',
  'req',
  'res',
  'responseTime',
]);

export function redisSinkStream(opts: RedisSinkOptions): Writable {
  const { redis, defaultSource, minLevel = 'debug' } = opts;
  const minRank = LEVEL_RANK[minLevel];
  let warned = false;
  let buffer = '';

  const writeLine = async (line: string): Promise<void> => {
    if (line.length === 0) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const level = pinoLevelToLog(typeof obj.level === 'number' ? obj.level : 30);
    if (LEVEL_RANK[level] < minRank) return;
    const source = isLogSource(obj.src) ? obj.src : defaultSource;
    const msg = typeof obj.msg === 'string' ? obj.msg : '';
    const serverId = typeof obj.serverId === 'string' ? obj.serverId : undefined;
    const ctx: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (PINO_META_KEYS.has(k)) continue;
      ctx[k] = obj[k];
    }
    const fields = encodeLogEntry({
      source,
      level,
      serverId,
      msg,
      ctx: Object.keys(ctx).length ? ctx : undefined,
    });
    const args: unknown[] = [PANEL_LOGS_STREAM, 'MAXLEN', '~', String(PANEL_LOGS_MAXLEN), '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    try {
      await redis.xadd(...args);
    } catch (err) {
      if (!warned) {
        warned = true;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[log-stream-sink] redis xadd failed: ${message}\n`);
      }
    }
  };

  return new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      Promise.all(lines.map((line) => writeLine(line))).then(
        () => cb(),
        () => cb(),
      );
    },
    final(cb) {
      if (buffer.length > 0) {
        writeLine(buffer).then(
          () => cb(),
          () => cb(),
        );
        buffer = '';
        return;
      }
      cb();
    },
  });
}
