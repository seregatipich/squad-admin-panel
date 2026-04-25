# Panel Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture verbose connector logs and 24h host-metric history in two capped Redis Streams, expose them via a minimal `/logs` page (live tail + filters) and a gzipped export endpoint, and make the dashboard's CPU/RAM/Disk/Network cards click-to-expand 24h graphs.

**Architecture:** Pino `multistream` shadow-writes every API/worker log line into `panel:logs` (Redis Stream, capped ~100k). A new tiny worker `worker-metrics-sampler` polls the bridge every 15s and packs 8-int samples into `host:metrics` (capped 5,760). Three new GET routes (`/api/v1/logs`, `/api/v1/logs/export`, `/api/v1/host/metrics/history`) drive a new `/logs` page and click-to-expand recharts modals on the existing dashboard cards. Reuses `host:view` for read, `host:metrics` for export.

**Tech Stack:** TypeScript, pino + `pino.multistream`, ioredis Streams (XADD/XREVRANGE), Fastify 5, Zod, Drizzle (existing audit_log read), Next 15 App Router, recharts (lazy-loaded), vitest, Playwright (existing e2e harness).

---

## File Structure

### New files

| Path | Purpose |
|---|---|
| `packages/shared-config/src/log-stream.ts` | `encodeLogEntry` / `decodeLogEntry` + source/level enums |
| `packages/shared-config/src/log-stream-sink.ts` | `attachStreamSink(logger, redis, source)` — pino multistream Redis writable |
| `packages/shared-config/src/metrics-pack.ts` | `packMetrics(m): number[]` / `unpackMetrics([8])` — int-only encoding |
| `packages/shared-config/test/log-stream.test.ts` | Encoder round-trip |
| `packages/shared-config/test/metrics-pack.test.ts` | Pack round-trip |
| `packages/shared-config/test/log-stream-sink.test.ts` | Pino → Redis writable behaves |
| `apps/api/src/plugins/bridge-heartbeat.ts` | 5s ping loop, transition logging |
| `apps/api/src/routes/logs.ts` | `/api/v1/logs` (list w/ filters) + `/api/v1/logs/export` (gzip stream) |
| `apps/api/src/lib/log-export.ts` | Stream-builder helpers used by the export route |
| `apps/api/test/logs-list.test.ts` | Filter + pagination integration test |
| `apps/api/test/logs-export.test.ts` | Section ordering + gzip integration test |
| `apps/api/test/metrics-history.test.ts` | Packed-payload integration test |
| `apps/api/test/bridge-heartbeat.test.ts` | Transition-log integration test |
| `apps/api/test/e2e/observability.e2e.test.ts` | Live-stack assertion of the full feature |
| `apps/workers/metrics-sampler/package.json` | New worker pkg manifest |
| `apps/workers/metrics-sampler/tsconfig.json` | TS config |
| `apps/workers/metrics-sampler/src/sampler.ts` | Pollable sampler with abort + interval injection (testable) |
| `apps/workers/metrics-sampler/src/index.ts` | Process entrypoint |
| `apps/workers/metrics-sampler/test/sampler.test.ts` | Unit tests w/ fake timers |
| `apps/web/src/components/MetricHistoryModal.tsx` | Modal that lazy-loads recharts |
| `apps/web/src/components/LogList.tsx` | Live-tailing list with filters |
| `apps/web/src/app/(dashboard)/logs/page.tsx` | Logs page shell |

### Modified files

| Path | Change |
|---|---|
| `packages/shared-config/src/index.ts` | Re-export new modules |
| `apps/api/src/server.ts` | Register `bridge-heartbeat` plugin + `logsRoutes` + attach stream sink |
| `apps/api/src/routes/host.ts` | Add `GET /api/v1/host/metrics/history` |
| `apps/workers/rcon/src/index.ts` | `attachStreamSink(log, redis, 'rcon')` + verbose lines |
| `apps/workers/rcon/src/supervisor.ts` | Verbose lines per §5.1 of spec |
| `apps/workers/log-ingest/src/index.ts` | `attachStreamSink(log, redis, 'log-ingest')` |
| `apps/workers/log-ingest/src/tail.ts` | Bytes/min counter + parser-miss sampling |
| `packages/bridge-client/src/client.ts` | More fine-grained `onLog` calls per §5.1 |
| `apps/web/src/app/(dashboard)/dashboard/page.tsx` | Cards become `<button>` opening modal |
| `apps/web/src/app/(dashboard)/layout.tsx` | "Логи" nav link |
| `apps/web/package.json` | `recharts` dep |
| `docker-compose.yml` | `worker-metrics-sampler` service |

---

## Task 1: Source/level enums + log entry types

**Files:**
- Create: `packages/shared-config/src/log-stream.ts`
- Test: `packages/shared-config/test/log-stream.test.ts`

- [ ] **Step 1.1: Write the failing test**

```ts
// packages/shared-config/test/log-stream.test.ts
import { describe, expect, it } from 'vitest';
import {
  decodeLogEntry,
  encodeLogEntry,
  LOG_LEVELS,
  LOG_SOURCES,
  sourceCode,
  sourceFromCode,
  type LogEntry,
} from '../src/log-stream.js';

describe('log-stream encoding', () => {
  it('encodes and decodes round-trip with all fields', () => {
    const entry: Omit<LogEntry, 'ts'> = {
      source: 'rcon',
      level: 'info',
      serverId: '01999999-9999-7999-8999-999999999999',
      msg: 'auth ok',
      ctx: { rttMs: 14 },
    };
    const fields = encodeLogEntry(entry);
    const decoded = decodeLogEntry('1735900000000-0', fields);
    expect(decoded).toEqual({ ts: 1735900000000, ...entry });
  });

  it('omits serverId and ctx when not provided', () => {
    const fields = encodeLogEntry({ source: 'bridge', level: 'debug', msg: 'alive rtt=2ms' });
    expect(fields).not.toHaveProperty('i');
    expect(fields).not.toHaveProperty('c');
    expect(fields.s).toBe('B');
    expect(fields.l).toBe('D');
    expect(fields.m).toBe('alive rtt=2ms');
  });

  it('round-trips an entry without optional fields', () => {
    const fields = encodeLogEntry({ source: 'api', level: 'warn', msg: 'rate-limit' });
    const decoded = decodeLogEntry('1700000000000-0', fields);
    expect(decoded.serverId).toBeUndefined();
    expect(decoded.ctx).toBeUndefined();
    expect(decoded.source).toBe('api');
    expect(decoded.level).toBe('warn');
  });

  it('throws on unknown source code', () => {
    expect(() => decodeLogEntry('1-0', { s: 'Z', l: 'I', m: 'x' })).toThrow(/source/);
  });

  it('exposes stable source codes', () => {
    expect(sourceCode('bridge')).toBe('B');
    expect(sourceCode('rcon')).toBe('R');
    expect(sourceFromCode('L')).toBe('log-ingest');
    expect(LOG_SOURCES).toEqual(['bridge', 'rcon', 'log-ingest', 'worker', 'depot', 'install', 'api']);
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
```

- [ ] **Step 1.2: Run test to confirm failure**

```bash
pnpm --filter @squad/shared-config test test/log-stream.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 1.3: Write the implementation**

```ts
// packages/shared-config/src/log-stream.ts
export const LOG_SOURCES = ['bridge', 'rcon', 'log-ingest', 'worker', 'depot', 'install', 'api'] as const;
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
  const sCode = fields.s;
  const lCode = fields.l;
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
```

- [ ] **Step 1.4: Re-export from index**

```ts
// packages/shared-config/src/index.ts — add this line near other exports
export * from './log-stream.js';
```

- [ ] **Step 1.5: Run test to confirm pass**

```bash
pnpm --filter @squad/shared-config test test/log-stream.test.ts
```
Expected: PASS.

- [ ] **Step 1.6: Commit**

```bash
git add packages/shared-config/src/log-stream.ts packages/shared-config/src/index.ts packages/shared-config/test/log-stream.test.ts
git commit -m "feat(shared-config): packed log-stream encoder for panel:logs"
```

---

## Task 2: Metric pack/unpack

**Files:**
- Create: `packages/shared-config/src/metrics-pack.ts`
- Test: `packages/shared-config/test/metrics-pack.test.ts`

- [ ] **Step 2.1: Write the failing test**

```ts
// packages/shared-config/test/metrics-pack.test.ts
import { describe, expect, it } from 'vitest';
import {
  HOST_METRICS_MAXLEN,
  HOST_METRICS_STREAM,
  packHostMetrics,
  unpackHostMetrics,
} from '../src/metrics-pack.js';

describe('metrics-pack', () => {
  it('packs to 8 integers in stable order', () => {
    const v = packHostMetrics({
      cpu_percent: 73.51,
      ram_used_bytes: 1234567890,
      disk_used_bytes: 55667788,
      net_rx_bytes_per_sec: 1234,
      net_tx_bytes_per_sec: 567,
      load_avg_1m: 0.53,
      load_avg_5m: 0.71,
      load_avg_15m: 0.89,
    });
    expect(v).toEqual([7351, 1234567890, 55667788, 1234, 567, 53, 71, 89]);
  });

  it('round-trips values within a tolerance of 0.01', () => {
    const original = {
      cpu_percent: 12.34,
      ram_used_bytes: 999,
      disk_used_bytes: 1,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 1.23,
      load_avg_15m: 4.56,
    };
    const round = unpackHostMetrics(packHostMetrics(original));
    expect(round.cpu_percent).toBeCloseTo(12.34, 2);
    expect(round.load_avg_5m).toBeCloseTo(1.23, 2);
    expect(round.ram_used_bytes).toBe(999);
  });

  it('exposes stable stream constants', () => {
    expect(HOST_METRICS_STREAM).toBe('host:metrics');
    expect(HOST_METRICS_MAXLEN).toBe(5760);
  });

  it('clamps negatives to 0', () => {
    const v = packHostMetrics({
      cpu_percent: -5,
      ram_used_bytes: 0,
      disk_used_bytes: 0,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
    });
    expect(v[0]).toBe(0);
  });
});
```

- [ ] **Step 2.2: Run test to confirm failure**

```bash
pnpm --filter @squad/shared-config test test/metrics-pack.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 2.3: Write the implementation**

```ts
// packages/shared-config/src/metrics-pack.ts
export interface HostMetricsSample {
  cpu_percent: number;
  ram_used_bytes: number;
  disk_used_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
}

export const HOST_METRICS_STREAM = 'host:metrics';
export const HOST_METRICS_MAXLEN = 5760; // 24h × 60min × (60/15)s

const clamp0 = (n: number): number => (n < 0 || Number.isNaN(n) ? 0 : n);
const x100 = (n: number): number => Math.round(clamp0(n) * 100);
const intB = (n: number): number => Math.round(clamp0(n));

export function packHostMetrics(m: HostMetricsSample): number[] {
  return [
    x100(m.cpu_percent),
    intB(m.ram_used_bytes),
    intB(m.disk_used_bytes),
    intB(m.net_rx_bytes_per_sec),
    intB(m.net_tx_bytes_per_sec),
    x100(m.load_avg_1m),
    x100(m.load_avg_5m),
    x100(m.load_avg_15m),
  ];
}

export function unpackHostMetrics(v: number[]): HostMetricsSample {
  return {
    cpu_percent: (v[0] ?? 0) / 100,
    ram_used_bytes: v[1] ?? 0,
    disk_used_bytes: v[2] ?? 0,
    net_rx_bytes_per_sec: v[3] ?? 0,
    net_tx_bytes_per_sec: v[4] ?? 0,
    load_avg_1m: (v[5] ?? 0) / 100,
    load_avg_5m: (v[6] ?? 0) / 100,
    load_avg_15m: (v[7] ?? 0) / 100,
  };
}
```

- [ ] **Step 2.4: Re-export from index**

```ts
// packages/shared-config/src/index.ts — add
export * from './metrics-pack.js';
```

- [ ] **Step 2.5: Run test to confirm pass**

```bash
pnpm --filter @squad/shared-config test test/metrics-pack.test.ts
```
Expected: PASS.

- [ ] **Step 2.6: Commit**

```bash
git add packages/shared-config/src/metrics-pack.ts packages/shared-config/src/index.ts packages/shared-config/test/metrics-pack.test.ts
git commit -m "feat(shared-config): packed host metrics encoder for host:metrics"
```

---

## Task 3: Pino multistream Redis sink

**Files:**
- Create: `packages/shared-config/src/log-stream-sink.ts`
- Test: `packages/shared-config/test/log-stream-sink.test.ts`

The sink is a `Writable` that consumes pino's NDJSON output and XADDs each line to `panel:logs`. Best-effort: a Redis error is logged once via `process.stderr.write` (avoiding any pino → Redis loop) and dropped.

- [ ] **Step 3.1: Write the failing test**

```ts
// packages/shared-config/test/log-stream-sink.test.ts
import { describe, expect, it, vi } from 'vitest';
import { redisSinkStream } from '../src/log-stream-sink.js';

interface XaddCall { stream: string; args: unknown[] }

function fakeRedis(): { calls: XaddCall[]; xadd: (...a: unknown[]) => Promise<string> } {
  const calls: XaddCall[] = [];
  return {
    calls,
    xadd: async (...args: unknown[]) => {
      const [stream, ...rest] = args;
      calls.push({ stream: String(stream), args: rest });
      return '0-0';
    },
  };
}

describe('redisSinkStream', () => {
  it('encodes a pino info line into XADD fields', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api' });
    stream.write(JSON.stringify({ level: 30, msg: 'rate-limit', extra: 1 }) + '\n');
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(r.calls).toHaveLength(1);
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('panel:logs');
    expect(flat).toContain('MAXLEN');
    expect(flat).toContain('100000');
    expect(flat).toContain('A'); // source code for api
    expect(flat).toContain('I'); // level info
    expect(flat).toContain('rate-limit');
  });

  it('routes to a per-record source if "src" field is set in the log', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api' });
    stream.write(JSON.stringify({ level: 40, msg: 'down', src: 'bridge' }) + '\n');
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('B');
  });

  it('attaches serverId from log payload', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'rcon' });
    stream.write(
      JSON.stringify({ level: 30, msg: 'auth ok', serverId: '01999999-9999-7999-8999-999999999999' }) + '\n',
    );
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    const flat = r.calls[0].args.flat();
    expect(flat).toContain('01999999-9999-7999-8999-999999999999');
  });

  it('swallows redis errors without throwing', async () => {
    const xaddErr = vi.fn(async () => {
      throw new Error('boom');
    });
    const stream = redisSinkStream({
      redis: { xadd: xaddErr } as never,
      defaultSource: 'api',
    });
    stream.write(JSON.stringify({ level: 30, msg: 'x' }) + '\n');
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(xaddErr).toHaveBeenCalledTimes(1); // no exception leaked
  });

  it('skips lines below the configured minimum level', async () => {
    const r = fakeRedis();
    const stream = redisSinkStream({ redis: r as never, defaultSource: 'api', minLevel: 'warn' });
    stream.write(JSON.stringify({ level: 30, msg: 'info-line' }) + '\n');
    stream.write(JSON.stringify({ level: 40, msg: 'warn-line' }) + '\n');
    stream.end();
    await new Promise<void>((resolve) => stream.on('finish', resolve));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].args.flat()).toContain('warn-line');
  });
});
```

- [ ] **Step 3.2: Run test to confirm failure**

```bash
pnpm --filter @squad/shared-config test test/log-stream-sink.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3.3: Write the implementation**

```ts
// packages/shared-config/src/log-stream-sink.ts
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
  [60, 'error'], // fatal collapses to error
  [50, 'error'],
  [40, 'warn'],
  [30, 'info'],
  [20, 'debug'],
  [10, 'debug'], // trace collapses to debug
];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function pinoLevelToLog(n: number): LogLevel {
  for (const [k, v] of PINO_TO_LEVEL) if (n >= k) return v;
  return 'debug';
}

function isLogSource(s: unknown): s is LogSource {
  return s === 'bridge' || s === 'rcon' || s === 'log-ingest' || s === 'worker' ||
    s === 'depot' || s === 'install' || s === 'api';
}

let warnedOnce = false;
function warnOnce(err: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  // stderr — never go through the pino logger here, that's the loop we're avoiding.
  process.stderr.write(`[log-stream-sink] redis xadd failed: ${(err as Error).message}\n`);
}

export function redisSinkStream(opts: RedisSinkOptions): Writable {
  const { redis, defaultSource, minLevel = 'debug' } = opts;
  const minRank = LEVEL_RANK[minLevel];
  let buffer = '';
  return new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      Promise.all(lines.map((line) => writeLine(line, redis, defaultSource, minRank))).then(
        () => cb(),
        () => cb(),
      );
    },
    final(cb) {
      if (buffer.length > 0) {
        writeLine(buffer, redis, defaultSource, minRank).then(
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

async function writeLine(
  line: string,
  redis: RedisLike,
  defaultSource: LogSource,
  minRank: number,
): Promise<void> {
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
    if (k === 'level' || k === 'msg' || k === 'time' || k === 'pid' || k === 'hostname' ||
        k === 'src' || k === 'serverId' || k === 'service' || k === 'v') continue;
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
  for (const [k, v] of Object.entries(fields)) {
    args.push(k, v);
  }
  try {
    await redis.xadd(...args);
  } catch (err) {
    warnOnce(err);
  }
}

export interface AttachStreamSinkOptions {
  defaultSource: LogSource;
  minLevel?: LogLevel;
}

export function attachStreamSink(redis: RedisLike, opts: AttachStreamSinkOptions): Writable {
  return redisSinkStream({ redis, defaultSource: opts.defaultSource, minLevel: opts.minLevel });
}
```

- [ ] **Step 3.4: Re-export**

```ts
// packages/shared-config/src/index.ts — add
export * from './log-stream-sink.js';
```

- [ ] **Step 3.5: Run test to confirm pass**

```bash
pnpm --filter @squad/shared-config test test/log-stream-sink.test.ts
```
Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
git add packages/shared-config/src/log-stream-sink.ts packages/shared-config/src/index.ts packages/shared-config/test/log-stream-sink.test.ts
git commit -m "feat(shared-config): pino-multistream redis sink for panel:logs"
```

---

## Task 4: Wire sink into API logger

**Files:**
- Modify: `apps/api/src/lib/logger.ts`
- Modify: `apps/api/src/server.ts`

The API gets the sink at boot; pino is reconstructed as a multistream once Redis is available. Implementation: build the base pino instance with multistream that includes stdout AND a function returning the redis writable when Redis is registered. Cleanest path: leave `buildLogger` as-is for stdout, then in `server.ts` after `redisPlugin` registration, attach a child sink via `app.log[sym]` — but pino doesn't allow late-adding sinks. The accepted pattern: wrap the logger in `pino.multistream` from the start and pass a placeholder Redis sink that no-ops until Redis is set.

- [ ] **Step 4.1: Update `buildLogger` to support multistream**

```ts
// apps/api/src/lib/logger.ts — replace existing exports
import { AsyncLocalStorage } from 'node:async_hooks';
import { type Writable } from 'node:stream';
import pino, { multistream, type DestinationStream } from 'pino';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
  userId?: string;
  sessionId?: string;
}

export const als = new AsyncLocalStorage<RequestContext>();

class LateSink {
  private inner: Writable | null = null;
  setInner(s: Writable): void {
    this.inner = s;
  }
  write(chunk: string): boolean {
    return this.inner ? this.inner.write(chunk) : true;
  }
}

export function buildLogger(level: string): { logger: pino.Logger; lateSink: LateSink } {
  const isDev = process.env.NODE_ENV !== 'production';
  const redact = {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.body.password',
      'req.body.passwordConfirm',
      'req.body.totp_code',
      'req.body.backup_code',
      '*.rcon_password',
      '*.license_key',
      '*.APP_ENCRYPTION_KEY',
    ],
    censor: '[redacted]',
  };
  const mixin = () => als.getStore() ?? {};
  const base = { service: 'api' };
  const lateSink = new LateSink();
  const sinkStream: DestinationStream = { write: (chunk) => lateSink.write(chunk) };
  if (isDev) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss' },
    });
    const logger = pino(
      { level, base, redact, mixin },
      multistream([
        { level: level as pino.Level, stream: pretty },
        { level: level as pino.Level, stream: sinkStream },
      ]),
    );
    return { logger, lateSink };
  }
  const logger = pino(
    { level, base, redact, mixin },
    multistream([
      { level: level as pino.Level, stream: process.stdout },
      { level: level as pino.Level, stream: sinkStream },
    ]),
  );
  return { logger, lateSink };
}

export type Logger = pino.Logger;
export type { LateSink };
```

- [ ] **Step 4.2: Update `server.ts` to pass `lateSink` to Redis plugin**

Locate the existing `const logger = buildLogger(config.LOG_LEVEL);` line (apps/api/src/server.ts:46) and replace:

```ts
// apps/api/src/server.ts — change near top of buildServer()
const { logger, lateSink } = buildLogger(config.LOG_LEVEL);
```

After `await app.register(redisPlugin, { config });` add:

```ts
import { redisSinkStream } from '@squad/shared-config'; // add at top with other imports

// ... after redis plugin
lateSink.setInner(redisSinkStream({ redis: app.redis, defaultSource: 'api' }));
```

- [ ] **Step 4.3: Typecheck the API**

```bash
pnpm --filter @squad/api typecheck
```
Expected: PASS.

- [ ] **Step 4.4: Smoke test (existing tests must still pass)**

```bash
pnpm --filter @squad/api test test/smoke.test.ts
```
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/src/lib/logger.ts apps/api/src/server.ts
git commit -m "feat(api): fan logs into panel:logs redis stream via pino multistream"
```

---

## Task 5: Wire sink into RCON worker

**Files:**
- Modify: `apps/workers/rcon/src/index.ts`

- [ ] **Step 5.1: Update worker bootstrap**

The top-level `const log = pino(...)` (apps/workers/rcon/src/index.ts:8-11) creates `log` before Redis exists, but the worker only needs the side-channel during `main()`. Move the logger construction inside `main()` after the `Redis` instance is available, and wire it through `multistream`:

```ts
// apps/workers/rcon/src/index.ts — replace the top-level pino with this construction inside main()
import pino, { multistream } from 'pino';
import { redisSinkStream } from '@squad/shared-config';

// REMOVE the existing top-level `const log = pino({...})` and `requiredEnv` definition that uses it.
// REDEFINE requiredEnv to take a logger argument, OR move it to throw-and-catch in main().

async function main() {
  // ... existing Redis construction ...
  const redis = new Redis(/* ... */);

  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-rcon' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'rcon' }) },
    ]),
  );

  // ... existing wiring (db, bridge, supervisor) using `log` ...
}
```

Pull the `requiredEnv` helper inside `main()` if it referenced `log` at top level — its current implementation already does, so move it adjacent to the new `log` definition.

- [ ] **Step 5.2: Typecheck**

```bash
pnpm --filter @squad/worker-rcon typecheck
```
Expected: PASS.

- [ ] **Step 5.3: Run unit tests for the worker (none break)**

```bash
pnpm --filter @squad/worker-rcon test
```
Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add apps/workers/rcon/src/index.ts
git commit -m "feat(worker-rcon): fan worker logs into panel:logs stream"
```

---

## Task 6: Wire sink into log-ingest worker

**Files:**
- Modify: `apps/workers/log-ingest/src/index.ts`

- [ ] **Step 6.1: Apply the same pattern as Task 5**

Move the `const log = pino(...)` block inside `main()` (apps/workers/log-ingest/src/index.ts) so it can reference the already-constructed `redis`, and wire the multistream:

```ts
import pino, { multistream } from 'pino';
import { redisSinkStream } from '@squad/shared-config';

async function main() {
  // ... existing redis construction ...
  const redis = new Redis(/* ... */);

  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-log-ingest' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'log-ingest' }) },
    ]),
  );

  // ... existing wiring (bridge, ingestor, tail) using `log` ...
}
```

- [ ] **Step 6.2: Typecheck + test**

```bash
pnpm --filter @squad/worker-log-ingest typecheck && pnpm --filter @squad/worker-log-ingest test
```
Expected: PASS.

- [ ] **Step 6.3: Commit**

```bash
git add apps/workers/log-ingest/src/index.ts
git commit -m "feat(worker-log-ingest): fan worker logs into panel:logs stream"
```

---

## Task 7: Verbose RCON connector log lines

**Files:**
- Modify: `apps/workers/rcon/src/supervisor.ts`

The supervisor already logs connect/disconnect/poll-fail. Add the missing transitions per spec §5.1.

- [ ] **Step 7.1: Add `auth ok` and explicit reconnect-with-backoff logs**

In `connectLoop()` (apps/workers/rcon/src/supervisor.ts), after `await this.client.connect();` and before `this.opts.log.info(... 'rcon connected')`, replace the existing 'rcon connected' line with:

```ts
this.opts.log.info(
  { serverId: this.target.serverId, host: this.target.host, port: this.target.port },
  'connect: rcon authenticated',
);
```

In the `catch` block of `connectLoop()`, after `this.opts.log.warn(... 'rcon connect failed')`, immediately add the upcoming-backoff log:

```ts
this.opts.log.warn(
  {
    serverId: this.target.serverId,
    backoffMs: this.backoffMs,
  },
  `reconnect in ${this.backoffMs}ms`,
);
```

- [ ] **Step 7.2: Add per-poll latency log**

Locate `schedulePoll()` (the body that calls listplayers). Wrap the listplayers call:

```ts
private schedulePoll(): void {
  const interval = this.opts.pollIntervalMs ?? 30_000;
  this.pollTimer = setInterval(async () => {
    if (this.stopped || !this.client) return;
    const t0 = Date.now();
    try {
      const raw = await this.client.send('ListPlayers');
      const list = parseListPlayers(raw);
      const dur = Date.now() - t0;
      this.opts.log.info(
        { serverId: this.target.serverId, ms: dur, n: list.players.length },
        'poll listplayers',
      );
      // ... existing persistence + emit
    } catch (err) {
      // existing error path
    }
  }, interval);
}
```

(If the existing `schedulePoll` doesn't have this exact shape, only add the `t0`/`dur`/`'poll listplayers'` log line — preserve the rest verbatim.)

- [ ] **Step 7.3: Run unit tests**

```bash
pnpm --filter @squad/worker-rcon test
```
Expected: PASS.

- [ ] **Step 7.4: Commit**

```bash
git add apps/workers/rcon/src/supervisor.ts
git commit -m "feat(worker-rcon): verbose connector lines (auth, poll latency, reconnect backoff)"
```

---

## Task 8: Verbose bridge-client log lines + heartbeat plugin

**Files:**
- Modify: `packages/bridge-client/src/client.ts`
- Create: `apps/api/src/plugins/bridge-heartbeat.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 8.1: Add per-RPC log lines to bridge-client**

In `packages/bridge-client/src/client.ts`, find the `request<T>(method, params, opts)` method. Wrap the call so that on entry/exit it calls `this.onLog`:

```ts
async request<T>(method: string, params: unknown, opts: { onStream?: ...; timeoutMs?: number } = {}): Promise<T> {
  const t0 = Date.now();
  this.onLog(`rpc ${method} start`, { src: 'bridge', method });
  try {
    const result = await this.requestImpl<T>(method, params, opts); // existing body refactored to a private method
    this.onLog(`rpc ${method} ${Date.now() - t0}ms ok`, { src: 'bridge', method, ms: Date.now() - t0 });
    return result;
  } catch (err) {
    this.onLog(`rpc ${method} ${Date.now() - t0}ms err: ${(err as Error).message}`, {
      src: 'bridge',
      method,
      ms: Date.now() - t0,
      err: (err as Error).message,
    });
    throw err;
  }
}
```

If `request` is currently the implementation directly, rename the existing body to `private async requestImpl<T>(...)` and add the wrapper above. **Do not** change any caller signatures.

- [ ] **Step 8.2: Write the failing heartbeat-plugin test**

```ts
// apps/api/test/bridge-heartbeat.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeLogEntry, PANEL_LOGS_STREAM } from '@squad/shared-config';
import { buildTestApp, type TestApp } from './integration/build-app.js';

let app: TestApp;
beforeEach(async () => {
  app = await buildTestApp();
});
afterEach(async () => {
  await app.close();
});

describe('bridge heartbeat plugin', () => {
  it('emits a `down` warn entry when ping rejects', async () => {
    app.bridge.ping = vi.fn(async () => {
      throw new Error('socket: ENOENT');
    });
    // run one tick manually
    await app.bridgeHeartbeat.tickOnce();
    const items = await app.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', 5);
    const entries = items.map(([id, fields]: [string, string[]]) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      return decodeLogEntry(id, obj);
    });
    expect(entries.some((e) => e.source === 'bridge' && e.level === 'warn' && e.msg.includes('down'))).toBe(true);
  });

  it('emits a `recovered` info entry when ping succeeds after a failure', async () => {
    app.bridge.ping = vi.fn(async () => {
      throw new Error('socket: ENOENT');
    });
    await app.bridgeHeartbeat.tickOnce();
    app.bridge.ping = vi.fn(async () => ({ version: 'test', hostname: 'h' }));
    await app.bridgeHeartbeat.tickOnce();
    const items = await app.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', 5);
    const entries = items.map(([id, fields]: [string, string[]]) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      return decodeLogEntry(id, obj);
    });
    expect(entries.some((e) => e.source === 'bridge' && e.level === 'info' && e.msg.includes('recovered'))).toBe(true);
  });
});
```

`buildTestApp` is the existing harness used by `apps/api/test/integration/*` (extend it as needed to expose `app.bridgeHeartbeat`). If no harness exists, create `apps/api/test/integration/build-app.ts` that boots the app with a stub bridge, real Redis (`process.env.REDIS_URL` or `redis://127.0.0.1:6379`), and an in-memory pg-mem or a test-DB connection.

- [ ] **Step 8.3: Run test to confirm failure**

```bash
pnpm --filter @squad/api test test/bridge-heartbeat.test.ts
```
Expected: FAIL — `app.bridgeHeartbeat` not defined.

- [ ] **Step 8.4: Write the heartbeat plugin**

```ts
// apps/api/src/plugins/bridge-heartbeat.ts
import fp from 'fastify-plugin';

export interface BridgeHeartbeatHandle {
  tickOnce(): Promise<void>;
  stop(): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    bridgeHeartbeat: BridgeHeartbeatHandle;
  }
}

const HEARTBEAT_INTERVAL_MS = 5_000;

export default fp(async (app) => {
  let lastWasUp = true;
  let lastDownAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tickOnce(): Promise<void> {
    const t0 = Date.now();
    try {
      await app.bridge.ping();
      const rttMs = Date.now() - t0;
      if (!lastWasUp) {
        const downForS = lastDownAt ? Math.round((Date.now() - lastDownAt) / 1000) : 0;
        app.log.info({ src: 'bridge', rttMs, downForS }, `recovered after ${downForS}s`);
      } else {
        app.log.debug({ src: 'bridge', rttMs }, `alive rtt=${rttMs}ms`);
      }
      lastWasUp = true;
      lastDownAt = null;
    } catch (err) {
      const message = (err as Error).message;
      if (lastWasUp) {
        lastDownAt = Date.now();
        app.log.warn({ src: 'bridge', err: message }, `down: ${message}`);
      } else {
        app.log.debug({ src: 'bridge', err: message }, 'still down');
      }
      lastWasUp = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tickOnce();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  app.decorate('bridgeHeartbeat', { tickOnce, stop });
  app.addHook('onReady', async () => start());
  app.addHook('onClose', async () => stop());
});
```

- [ ] **Step 8.5: Register in `server.ts`**

```ts
// apps/api/src/server.ts — add import
import bridgeHeartbeatPlugin from './plugins/bridge-heartbeat.js';

// ... after `await app.register(bridgePlugin, { config });`
await app.register(bridgeHeartbeatPlugin);
```

- [ ] **Step 8.6: Run tests to confirm pass**

```bash
pnpm --filter @squad/api test test/bridge-heartbeat.test.ts
```
Expected: PASS.

- [ ] **Step 8.7: Commit**

```bash
git add packages/bridge-client/src/client.ts apps/api/src/plugins/bridge-heartbeat.ts apps/api/src/server.ts apps/api/test/bridge-heartbeat.test.ts
git commit -m "feat(api): bridge heartbeat plugin with transition logging"
```

---

## Task 9: Verbose log-ingest tail logs

**Files:**
- Modify: `apps/workers/log-ingest/src/tail.ts`

- [ ] **Step 9.1: Add bytes/min counter and parser-miss sampling**

Replace the body of `tailContainerLogs` so the tail loop tracks byte counts and emits a debug log every 60s, plus warns on early end:

```ts
// apps/workers/log-ingest/src/tail.ts
import type { BridgeClient } from '@squad/bridge-client';
import type { Logger } from 'pino';

export function tailContainerLogs(params: {
  bridge: BridgeClient;
  name: string;
  log: Logger;
  onLine: (line: string) => void;
}): () => void {
  const { bridge, name, log, onLine } = params;
  let buffer = '';
  let aborted = false;
  let bytesThisMinute = 0;
  let linesThisMinute = 0;

  log.info({ container: name }, `tail start container=${name}`);

  const reportTimer = setInterval(() => {
    if (aborted) return;
    log.debug(
      { container: name, bytesPerMin: bytesThisMinute, linesPerMin: linesThisMinute },
      `tail bytes/min=${bytesThisMinute} lines/min=${linesThisMinute}`,
    );
    bytesThisMinute = 0;
    linesThisMinute = 0;
  }, 60_000);

  (async () => {
    try {
      await bridge.containerLogsFollow({ name, tail: 100 }, (frame) => {
        if (aborted) return;
        if (frame.stream !== 'stdout') return;
        const text = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
        bytesThisMinute += text.length;
        buffer += text;
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.length === 0) continue;
          linesThisMinute++;
          onLine(part);
        }
      });
      if (!aborted) {
        log.warn({ container: name }, 'tail dropped → restart');
      }
    } catch (err) {
      if (!aborted) {
        log.warn({ container: name, err: (err as Error).message }, 'tail dropped → restart');
      }
    } finally {
      clearInterval(reportTimer);
    }
  })();

  return () => {
    aborted = true;
    clearInterval(reportTimer);
  };
}
```

- [ ] **Step 9.2: Typecheck + test**

```bash
pnpm --filter @squad/worker-log-ingest typecheck && pnpm --filter @squad/worker-log-ingest test
```
Expected: PASS.

- [ ] **Step 9.3: Commit**

```bash
git add apps/workers/log-ingest/src/tail.ts
git commit -m "feat(worker-log-ingest): bytes/min counter + restart-on-drop log"
```

---

## Task 10: Metrics sampler worker (TDD)

**Files:**
- Create: `apps/workers/metrics-sampler/package.json`
- Create: `apps/workers/metrics-sampler/tsconfig.json`
- Create: `apps/workers/metrics-sampler/src/sampler.ts`
- Create: `apps/workers/metrics-sampler/src/index.ts`
- Create: `apps/workers/metrics-sampler/test/sampler.test.ts`

- [ ] **Step 10.1: Scaffold package**

```json
// apps/workers/metrics-sampler/package.json
{
  "name": "@squad/worker-metrics-sampler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --enable-source-maps dist/index.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@squad/bridge-client": "workspace:*",
    "@squad/shared-config": "workspace:*",
    "ioredis": "^5.4.1",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.1",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^3.2.4"
  }
}
```

```json
// apps/workers/metrics-sampler/tsconfig.json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 10.2: Write the failing sampler test**

```ts
// apps/workers/metrics-sampler/test/sampler.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSampler } from '../src/sampler.js';

interface XaddCall { stream: string; entries: Array<[string, string]> }

function makeRedis(): { calls: XaddCall[]; xadd: (...a: unknown[]) => Promise<string> } {
  const calls: XaddCall[] = [];
  return {
    calls,
    xadd: async (...args: unknown[]) => {
      const [stream, ..._rest] = args as [string, ...unknown[]];
      // collect every-other key/value after the trim spec + '*'
      const tail = (args as unknown[]).slice(5);
      const entries: Array<[string, string]> = [];
      for (let i = 0; i < tail.length; i += 2) {
        entries.push([String(tail[i]), String(tail[i + 1])]);
      }
      calls.push({ stream: String(stream), entries });
      return '0-0';
    },
  };
}

describe('runSampler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('XADDs one packed sample per tick to host:metrics', async () => {
    const redis = makeRedis();
    const bridgeMetrics = vi.fn(async () => ({
      cpu_percent: 50,
      ram_used_bytes: 100,
      ram_total_bytes: 200,
      disk_used_bytes: 100,
      disk_total_bytes: 1000,
      net_rx_bytes_per_sec: 10,
      net_tx_bytes_per_sec: 20,
      load_avg_1m: 0.5,
      load_avg_5m: 0.6,
      load_avg_15m: 0.7,
      sampled_at: '2026-04-25T00:00:00Z',
    }));
    const stop = runSampler({
      bridge: { hostMetrics: bridgeMetrics } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(305);
    stop();
    expect(bridgeMetrics).toHaveBeenCalled();
    expect(redis.calls.length).toBeGreaterThanOrEqual(3);
    expect(redis.calls[0].stream).toBe('host:metrics');
    const vEntry = redis.calls[0].entries.find(([k]) => k === 'v');
    expect(vEntry).toBeDefined();
    expect(JSON.parse(vEntry![1])).toEqual([5000, 100, 100, 10, 20, 50, 60, 70]);
  });

  it('continues sampling after a bridge error', async () => {
    const redis = makeRedis();
    let calls = 0;
    const bridgeMetrics = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('bridge down');
      return {
        cpu_percent: 1, ram_used_bytes: 1, ram_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2,
        net_rx_bytes_per_sec: 0, net_tx_bytes_per_sec: 0, load_avg_1m: 0, load_avg_5m: 0, load_avg_15m: 0,
        sampled_at: '2026-04-25T00:00:00Z',
      };
    });
    const stop = runSampler({
      bridge: { hostMetrics: bridgeMetrics } as never,
      redis: redis as never,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(305);
    stop();
    expect(redis.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 10.3: Run test to confirm failure**

```bash
pnpm --filter @squad/worker-metrics-sampler test
```
Expected: FAIL — module not found.

- [ ] **Step 10.4: Implement sampler**

```ts
// apps/workers/metrics-sampler/src/sampler.ts
import type { BridgeClient } from '@squad/bridge-client';
import {
  HOST_METRICS_MAXLEN,
  HOST_METRICS_STREAM,
  packHostMetrics,
} from '@squad/shared-config';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface RunSamplerOpts {
  bridge: Pick<BridgeClient, 'hostMetrics'>;
  redis: Pick<Redis, 'xadd'>;
  log: Logger;
  intervalMs?: number;
}

export function runSampler(opts: RunSamplerOpts): () => void {
  const { bridge, redis, log } = opts;
  const intervalMs = opts.intervalMs ?? 15_000;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const m = await bridge.hostMetrics();
      const v = packHostMetrics(m);
      await redis.xadd(
        HOST_METRICS_STREAM,
        'MAXLEN',
        '~',
        String(HOST_METRICS_MAXLEN),
        '*',
        'v',
        JSON.stringify(v),
      );
      log.debug({ v }, 'metrics sample stored');
    } catch (err) {
      log.warn({ err: (err as Error).message }, `metrics sample failed: ${(err as Error).message}`);
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // run once immediately
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [ ] **Step 10.5: Run test to confirm pass**

```bash
pnpm --filter @squad/worker-metrics-sampler test
```
Expected: PASS.

- [ ] **Step 10.6: Implement entrypoint**

```ts
// apps/workers/metrics-sampler/src/index.ts
import { BridgeClient } from '@squad/bridge-client';
import { redisSinkStream, startHeartbeat } from '@squad/shared-config';
import Redis from 'ioredis';
import pino, { multistream } from 'pino';
import { runSampler } from './sampler.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const redis = new Redis(requiredEnv('REDIS_URL'), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(2000, 200 * 2 ** Math.min(times, 6)),
  });
  const log = pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker-metrics-sampler' } },
    multistream([
      { stream: process.stdout },
      { stream: redisSinkStream({ redis, defaultSource: 'worker' }) },
    ]),
  );

  const bridge = new BridgeClient({
    socketPath: process.env.BRIDGE_SOCKET ?? '/run/panel-host-bridge.sock',
    onLog: (m, meta) => log.debug({ src: 'bridge', ...meta }, m),
  });

  const stopHeartbeat = startHeartbeat(redis, 'metrics-sampler', { intervalMs: 5_000 });
  const stopSampler = runSampler({ bridge, redis, log });

  const shutdown = async (sig: NodeJS.Signals) => {
    log.info({ sig }, 'shutdown');
    stopSampler();
    stopHeartbeat();
    await redis.quit().catch(() => undefined);
    await bridge.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 10.7: Typecheck + test**

```bash
pnpm install && pnpm --filter @squad/worker-metrics-sampler typecheck && pnpm --filter @squad/worker-metrics-sampler test
```
Expected: PASS.

- [ ] **Step 10.8: Commit**

```bash
git add apps/workers/metrics-sampler/ pnpm-lock.yaml
git commit -m "feat(worker-metrics-sampler): poll bridge.host_metrics every 15s into host:metrics"
```

---

## Task 11: Add metrics-sampler to docker-compose

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker/worker.Dockerfile` (or whichever Dockerfile builds the workers — check `docker/`)

- [ ] **Step 11.1: Inspect existing worker compose entries**

```bash
grep -n "worker-rcon\|worker-log-ingest" docker-compose.yml
```

- [ ] **Step 11.2: Add the new service mirroring `worker-rcon`'s shape**

Add an entry under `services:` (after the other `worker-*` services). Use the same Dockerfile and pass `--filter @squad/worker-metrics-sampler` in the start command, and the same env block (REDIS_URL, BRIDGE_SOCKET).

```yaml
  worker-metrics-sampler:
    build:
      context: .
      dockerfile: docker/worker.Dockerfile
      args:
        WORKER_NAME: worker-metrics-sampler
    restart: unless-stopped
    environment:
      REDIS_URL: redis://redis:6379
      BRIDGE_SOCKET: /run/panel-host-bridge.sock
      LOG_LEVEL: ${LOG_LEVEL:-info}
    user: "0:${PANEL_GID:-987}"
    volumes:
      - /run/panel-host-bridge.sock:/run/panel-host-bridge.sock
    depends_on:
      redis:
        condition: service_healthy
    logging: *default-logging
```

If `docker/worker.Dockerfile` requires the worker name baked in another way, mirror the pattern used by an existing worker — don't introduce a new pattern.

- [ ] **Step 11.3: Verify compose lints**

```bash
docker compose config > /dev/null
```
Expected: no errors.

- [ ] **Step 11.4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): add worker-metrics-sampler service"
```

---

## Task 12: API route — host metrics history (TDD)

**Files:**
- Modify: `apps/api/src/routes/host.ts`
- Create: `apps/api/test/metrics-history.test.ts`

- [ ] **Step 12.1: Write the failing test**

```ts
// apps/api/test/metrics-history.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_METRICS_STREAM, packHostMetrics } from '@squad/shared-config';
import { buildTestApp, type TestApp } from './integration/build-app.js';

let app: TestApp;
beforeEach(async () => {
  app = await buildTestApp();
  await app.redis.del(HOST_METRICS_STREAM);
});
afterEach(async () => {
  await app.close();
});

const sample = {
  cpu_percent: 50, ram_used_bytes: 100, ram_total_bytes: 200,
  disk_used_bytes: 1, disk_total_bytes: 2,
  net_rx_bytes_per_sec: 0, net_tx_bytes_per_sec: 0,
  load_avg_1m: 0, load_avg_5m: 0, load_avg_15m: 0,
};

describe('GET /api/v1/host/metrics/history', () => {
  it('returns paired ts/v arrays in chronological order', async () => {
    for (let i = 0; i < 5; i++) {
      const v = packHostMetrics({ ...sample, cpu_percent: i * 10 });
      await app.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(v));
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=86400',
      cookies: app.ownerCookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ts).toHaveLength(5);
    expect(body.v).toHaveLength(5);
    expect(body.v[0][0]).toBe(0);
    expect(body.v[4][0]).toBe(40 * 100);
    // chronological
    for (let i = 1; i < body.ts.length; i++) {
      expect(body.ts[i]).toBeGreaterThanOrEqual(body.ts[i - 1]);
    }
  });

  it('respects the seconds window and excludes older samples', async () => {
    // 25h-old entry
    const old = packHostMetrics(sample);
    await app.redis.xadd(HOST_METRICS_STREAM, `${Date.now() - 25 * 3600 * 1000}-0`, 'v', JSON.stringify(old));
    const recent = packHostMetrics({ ...sample, cpu_percent: 99 });
    await app.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(recent));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history?seconds=3600',
      cookies: app.ownerCookies,
    });
    const body = res.json();
    expect(body.v).toHaveLength(1);
    expect(body.v[0][0]).toBe(99 * 100);
  });

  it('rejects without host:metrics permission', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics/history',
      cookies: app.viewerCookies, // viewer has host:view but not host:metrics
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 12.2: Run test to confirm failure**

```bash
pnpm --filter @squad/api test test/metrics-history.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 12.3: Add the route**

```ts
// apps/api/src/routes/host.ts — append a new route inside hostRoutes
import { HOST_METRICS_STREAM } from '@squad/shared-config';
import { z } from 'zod';

// inside `const hostRoutes: FastifyPluginAsync = async (app) => { ... }` add:
app.get(
  '/api/v1/host/metrics/history',
  {
    config: { permissions: ['host:metrics'], audit: false },
    schema: {
      querystring: z.object({ seconds: z.coerce.number().int().min(1).max(86_400).default(86_400) }),
    },
  },
  async (req) => {
    const { seconds } = req.query as { seconds: number };
    const minId = `${Date.now() - seconds * 1000}-0`;
    const items = (await app.redis.xrange(HOST_METRICS_STREAM, minId, '+')) as Array<
      [string, string[]]
    >;
    const ts: number[] = [];
    const v: number[][] = [];
    for (const [id, fields] of items) {
      const idMs = Number.parseInt(id.split('-')[0] ?? '0', 10);
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      if (!obj.v) continue;
      try {
        v.push(JSON.parse(obj.v) as number[]);
        ts.push(idMs);
      } catch {
        // skip malformed sample; never throw
      }
    }
    return { ts, v };
  },
);
```

- [ ] **Step 12.4: Run test to confirm pass**

```bash
pnpm --filter @squad/api test test/metrics-history.test.ts
```
Expected: PASS.

- [ ] **Step 12.5: Commit**

```bash
git add apps/api/src/routes/host.ts apps/api/test/metrics-history.test.ts
git commit -m "feat(api): GET /api/v1/host/metrics/history (packed paired arrays)"
```

---

## Task 13: API route — list panel logs (TDD)

**Files:**
- Create: `apps/api/src/routes/logs.ts`
- Modify: `apps/api/src/server.ts` (register the new route plugin)
- Create: `apps/api/test/logs-list.test.ts`

- [ ] **Step 13.1: Write the failing test**

```ts
// apps/api/test/logs-list.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeLogEntry, PANEL_LOGS_STREAM } from '@squad/shared-config';
import { buildTestApp, type TestApp } from './integration/build-app.js';

let app: TestApp;
beforeEach(async () => {
  app = await buildTestApp();
  await app.redis.del(PANEL_LOGS_STREAM);
});
afterEach(async () => {
  await app.close();
});

async function seed(entries: Array<{ source: 'bridge' | 'rcon' | 'api'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; serverId?: string }>): Promise<void> {
  for (const e of entries) {
    const fields = encodeLogEntry(e);
    const args: unknown[] = [PANEL_LOGS_STREAM, '*'];
    for (const [k, v] of Object.entries(fields)) args.push(k, v);
    await app.redis.xadd(...args);
  }
}

describe('GET /api/v1/logs', () => {
  it('returns latest entries (newest first) with default limit', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a' },
      { source: 'bridge', level: 'warn', msg: 'b' },
      { source: 'api', level: 'error', msg: 'c' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs', cookies: app.ownerCookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries[0].msg).toBe('c');
    expect(body.entries.at(-1).msg).toBe('a');
    expect(body.entries).toHaveLength(3);
  });

  it('filters by source', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a' },
      { source: 'bridge', level: 'info', msg: 'b' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?src=R', cookies: app.ownerCookies });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].source).toBe('rcon');
  });

  it('filters by minimum level', async () => {
    await seed([
      { source: 'api', level: 'debug', msg: 'a' },
      { source: 'api', level: 'info', msg: 'b' },
      { source: 'api', level: 'error', msg: 'c' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?lvl=warn', cookies: app.ownerCookies });
    const body = res.json();
    expect(body.entries.map((e: { msg: string }) => e.msg)).toEqual(['c']);
  });

  it('filters by serverId', async () => {
    await seed([
      { source: 'rcon', level: 'info', msg: 'a', serverId: '01999999-9999-7999-8999-999999999999' },
      { source: 'rcon', level: 'info', msg: 'b' },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/logs?srv=01999999-9999-7999-8999-999999999999',
      cookies: app.ownerCookies,
    });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].msg).toBe('a');
  });

  it('returns 403 without host:view', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs', cookies: app.unprivilegedCookies });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 13.2: Run test to confirm failure**

```bash
pnpm --filter @squad/api test test/logs-list.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 13.3: Implement the route**

```ts
// apps/api/src/routes/logs.ts
import {
  decodeLogEntry,
  LOG_LEVELS,
  type LogLevel,
  PANEL_LOGS_STREAM,
  sourceCode,
} from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const SOURCE_CODES = ['B', 'R', 'L', 'W', 'D', 'I', 'A'] as const;
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const logsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/logs',
    {
      config: { permissions: ['host:view'], audit: false },
      schema: {
        querystring: z.object({
          src: z.string().optional(),    // comma-separated codes: "B,R"
          lvl: z.enum(LOG_LEVELS).optional(),
          srv: z.string().uuid().optional(),
          q: z.string().max(120).optional(), // substring search on msg
          before: z.string().regex(/^\d+-\d+$/).optional(),
          after: z.string().regex(/^\d+-\d+$/).optional(),
          limit: z.coerce.number().int().min(1).max(2000).default(500),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        src?: string; lvl?: LogLevel; srv?: string; q?: string;
        before?: string; after?: string; limit: number;
      };
      const codes = q.src
        ? new Set(q.src.split(',').filter((c) => SOURCE_CODES.includes(c as (typeof SOURCE_CODES)[number])))
        : null;
      const minRank = q.lvl ? LEVEL_RANK[q.lvl] : 0;

      // Live tail uses ?after=<last_id>; backfill uses ?before=<oldest_id>.
      let items: Array<[string, string[]]>;
      if (q.after) {
        items = (await app.redis.xrange(PANEL_LOGS_STREAM, `(${q.after}`, '+', 'COUNT', q.limit)) as never;
        items.reverse(); // newest first for UI
      } else if (q.before) {
        items = (await app.redis.xrevrange(PANEL_LOGS_STREAM, `(${q.before}`, '-', 'COUNT', q.limit)) as never;
      } else {
        items = (await app.redis.xrevrange(PANEL_LOGS_STREAM, '+', '-', 'COUNT', q.limit)) as never;
      }

      const entries = items
        .map(([id, fields]) => {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          try {
            return { id, ...decodeLogEntry(id, obj) };
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((e) => {
          if (codes && !codes.has(sourceCode(e.source))) return false;
          if (LEVEL_RANK[e.level] < minRank) return false;
          if (q.srv && e.serverId !== q.srv) return false;
          if (q.q && !e.msg.toLowerCase().includes(q.q.toLowerCase())) return false;
          return true;
        });

      return { entries };
    },
  );
};

export default logsRoutes;
```

- [ ] **Step 13.4: Register in server.ts**

```ts
// apps/api/src/server.ts — add import
import logsRoutes from './routes/logs.js';
// after `await app.register(auditRoutes);` (or wherever feels stylistically consistent):
await app.register(logsRoutes);
```

- [ ] **Step 13.5: Run test to confirm pass**

```bash
pnpm --filter @squad/api test test/logs-list.test.ts
```
Expected: PASS.

- [ ] **Step 13.6: Commit**

```bash
git add apps/api/src/routes/logs.ts apps/api/src/server.ts apps/api/test/logs-list.test.ts
git commit -m "feat(api): GET /api/v1/logs — list panel:logs with filters"
```

---

## Task 14: API route — export bundle (TDD)

**Files:**
- Create: `apps/api/src/lib/log-export.ts`
- Modify: `apps/api/src/routes/logs.ts` (add `/export`)
- Create: `apps/api/test/logs-export.test.ts`

- [ ] **Step 14.1: Write the failing test**

```ts
// apps/api/test/logs-export.test.ts
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeLogEntry,
  HOST_METRICS_STREAM,
  PANEL_LOGS_STREAM,
  packHostMetrics,
} from '@squad/shared-config';
import { buildTestApp, type TestApp } from './integration/build-app.js';

let app: TestApp;
beforeEach(async () => {
  app = await buildTestApp();
  await app.redis.del(PANEL_LOGS_STREAM);
  await app.redis.del(HOST_METRICS_STREAM);
});
afterEach(async () => {
  await app.close();
});

async function seedLog(e: { source: 'bridge' | 'rcon' | 'api' | 'log-ingest' | 'worker' | 'depot' | 'install'; level: 'info' | 'warn' | 'debug' | 'error'; msg: string; serverId?: string }): Promise<void> {
  const fields = encodeLogEntry(e);
  const args: unknown[] = [PANEL_LOGS_STREAM, '*'];
  for (const [k, v] of Object.entries(fields)) args.push(k, v);
  await app.redis.xadd(...args);
}

describe('GET /api/v1/logs/export', () => {
  it('serves a gzipped sectioned text bundle with all expected headers', async () => {
    // seed each source at least once
    await seedLog({ source: 'bridge', level: 'info', msg: 'alive rtt=2ms' });
    await seedLog({ source: 'rcon', level: 'info', msg: 'auth ok', serverId: app.serverIdAlpha });
    await seedLog({ source: 'log-ingest', level: 'info', msg: 'tail start', serverId: app.serverIdAlpha });
    await seedLog({ source: 'worker', level: 'info', msg: 'heartbeat ok' });
    await seedLog({ source: 'depot', level: 'info', msg: 'update progress 50%' });
    await seedLog({ source: 'install', level: 'info', msg: 'seeded 19 cfg files' });
    await seedLog({ source: 'api', level: 'warn', msg: 'rate-limit hit' });
    // seed metrics
    const v = packHostMetrics({
      cpu_percent: 50, ram_used_bytes: 1, ram_total_bytes: 2, disk_used_bytes: 1, disk_total_bytes: 2,
      net_rx_bytes_per_sec: 0, net_tx_bytes_per_sec: 0, load_avg_1m: 0, load_avg_5m: 0, load_avg_15m: 0,
    });
    await app.redis.xadd(HOST_METRICS_STREAM, '*', 'v', JSON.stringify(v));

    // stub bridge.containerLogsFollow to yield 1 line per server
    app.bridge.containerLogsFollow = vi.fn(async (_p, onFrame) => {
      onFrame({ stream: 'stdout', data: 'squad-game line A\n' });
    }) as never;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      cookies: app.ownerCookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const text = gunzipSync(res.rawPayload).toString('utf-8');
    const sections = [
      '===== BRIDGE =====',
      `===== RCON server`,
      `===== LOG-INGEST server`,
      '===== WORKERS =====',
      '===== DEPOT / INSTALL =====',
      '===== API =====',
      '===== HOST METRICS 24h (CSV) =====',
      'ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15',
      '===== AUDIT (last 24h) =====',
      '===== SQUAD GAME LOGS server',
    ];
    let pos = 0;
    for (const s of sections) {
      const i = text.indexOf(s, pos);
      expect(i, `section "${s}" missing or out of order`).toBeGreaterThanOrEqual(0);
      pos = i;
    }
    expect(text).toContain('alive rtt=2ms');
    expect(text).toContain('auth ok');
  });

  it('returns 403 without host:metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/export',
      cookies: app.viewerCookies, // host:view but not host:metrics
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 14.2: Run test to confirm failure**

```bash
pnpm --filter @squad/api test test/logs-export.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 14.3: Build the section streamer helper**

```ts
// apps/api/src/lib/log-export.ts
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { auditLog } from '@squad/db';
import {
  decodeLogEntry,
  HOST_METRICS_STREAM,
  PANEL_LOGS_STREAM,
  unpackHostMetrics,
} from '@squad/shared-config';
import { gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const SECTION = (label: string): string => `\n===== ${label} =====\n`;

const LEVEL_3: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

interface ServerRef { id: string; display_name: string }

function fmtIso(ts: number): string {
  return new Date(ts).toISOString();
}

function fmtEntry(e: ReturnType<typeof decodeLogEntry>, serverName?: string): string {
  const ctx = e.ctx ? `  ctx=${JSON.stringify(e.ctx)}` : '';
  const tag = serverName ? ` [${serverName}]` : '';
  return `${fmtIso(e.ts)} ${LEVEL_3[e.level] ?? '???'} [${e.source}]${tag} ${e.msg}${ctx}\n`;
}

async function* iterateLogs(
  app: FastifyInstance,
  predicate: (e: ReturnType<typeof decodeLogEntry>) => boolean,
): AsyncGenerator<ReturnType<typeof decodeLogEntry>> {
  // page through XRANGE 1000 at a time (oldest first)
  let cursor = '-';
  for (;;) {
    const items = (await app.redis.xrange(PANEL_LOGS_STREAM, cursor === '-' ? '-' : `(${cursor}`, '+', 'COUNT', 1000)) as Array<[string, string[]]>;
    if (items.length === 0) return;
    for (const [id, fields] of items) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      try {
        const e = decodeLogEntry(id, obj);
        if (predicate(e)) yield e;
      } catch {
        /* skip malformed */
      }
    }
    const lastId = items[items.length - 1][0];
    if (lastId === cursor) return;
    cursor = lastId;
  }
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
    for await (const e of iterateLogs(app, (x) => x.source === 'log-ingest' && x.serverId === s.id)) {
      yield fmtEntry(e, s.display_name);
    }
  }

  yield SECTION('WORKERS');
  for await (const e of iterateLogs(app, (x) => x.source === 'worker')) yield fmtEntry(e);

  yield SECTION('DEPOT / INSTALL');
  for await (const e of iterateLogs(app, (x) => x.source === 'depot' || x.source === 'install')) yield fmtEntry(e);

  yield SECTION('API');
  for await (const e of iterateLogs(app, (x) => x.source === 'api')) yield fmtEntry(e);

  yield SECTION('HOST METRICS 24h (CSV)');
  yield 'ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15\n';
  const cutoff = `${Date.now() - 86_400_000}-0`;
  const ms = (await app.redis.xrange(HOST_METRICS_STREAM, cutoff, '+')) as Array<[string, string[]]>;
  for (const [id, fields] of ms) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    if (!obj.v) continue;
    try {
      const m = unpackHostMetrics(JSON.parse(obj.v) as number[]);
      const ts = fmtIso(Number.parseInt(id.split('-')[0] ?? '0', 10));
      yield `${ts},${m.cpu_percent.toFixed(2)},${m.ram_used_bytes},${m.disk_used_bytes},${m.net_rx_bytes_per_sec},${m.net_tx_bytes_per_sec},${m.load_avg_1m.toFixed(2)},${m.load_avg_5m.toFixed(2)},${m.load_avg_15m.toFixed(2)}\n`;
    } catch {
      /* skip malformed */
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
    .orderBy(auditLog.id);
  for (const row of auditRows) {
    yield `${row.createdAt.toISOString()} ${row.actorKind} ${row.actionType} ${row.targetType ?? ''}/${row.targetId ?? ''} ${row.statusCode ?? ''}\n`;
  }

  for (const s of servers) {
    yield SECTION(`SQUAD GAME LOGS server "${s.display_name}" (${s.id})`);
    try {
      const collected: string[] = [];
      await app.bridge.containerLogsFollow(
        { name: `squad-${s.id}`, tail: 5000, since: 86_400 },
        (frame: { stream: string; data: unknown }) => {
          if (frame.stream !== 'stdout') return;
          const text = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
          collected.push(text);
        },
      );
      yield collected.join('');
    } catch (err) {
      yield `[bridge container_logs_follow error: ${(err as Error).message}]\n`;
    }
  }
}

export function streamBundle(
  app: FastifyInstance,
  servers: ServerRef[],
): NodeJS.ReadableStream {
  const gen = exportBundle(app, servers);
  const src = Readable.from(gen, { objectMode: false });
  return src.pipe(createGzip());
}
```

- [ ] **Step 14.4: Add the export route**

```ts
// apps/api/src/routes/logs.ts — append inside the same plugin
import { streamBundle } from '../lib/log-export.js';
import { servers as serversTbl } from '@squad/db';

app.get(
  '/api/v1/logs/export',
  { config: { permissions: ['host:metrics'], audit: false } },
  async (_req, reply) => {
    const rows = await app.db.select({ id: serversTbl.id, display_name: serversTbl.display_name }).from(serversTbl);
    const fname = `panel-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt.gz`;
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Encoding', 'gzip');
    reply.header('Content-Disposition', `attachment; filename="${fname}"`);
    return reply.send(streamBundle(app, rows));
  },
);
```

- [ ] **Step 14.5: Run test to confirm pass**

```bash
pnpm --filter @squad/api test test/logs-export.test.ts
```
Expected: PASS.

- [ ] **Step 14.6: Commit**

```bash
git add apps/api/src/lib/log-export.ts apps/api/src/routes/logs.ts apps/api/test/logs-export.test.ts
git commit -m "feat(api): GET /api/v1/logs/export — gzipped sectioned bundle"
```

---

## Task 15: Add `recharts` to web

**Files:**
- Modify: `apps/web/package.json`

- [ ] **Step 15.1: Install**

```bash
pnpm --filter @squad/web add recharts
```

- [ ] **Step 15.2: Verify it landed**

```bash
grep recharts apps/web/package.json
```
Expected: dep present.

- [ ] **Step 15.3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add recharts for metric history modals"
```

---

## Task 16: MetricHistoryModal component

**Files:**
- Create: `apps/web/src/components/MetricHistoryModal.tsx`

The modal lazy-loads recharts so the dashboard initial bundle doesn't grow.

- [ ] **Step 16.1: Write the modal**

```tsx
// apps/web/src/components/MetricHistoryModal.tsx
'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { unpackHostMetrics } from '@squad/shared-config';

const Chart = dynamic(() => import('./MetricHistoryChart'), { ssr: false, loading: () => (
  <div className="h-72 flex items-center justify-center text-neutral-500">Загрузка графика…</div>
) });

export type MetricKey = 'cpu' | 'ram' | 'disk' | 'net';

interface HistoryResponse { ts: number[]; v: number[][] }

interface Point { ts: number; cpu: number; ram_pct: number; disk_pct: number; rx: number; tx: number }

export function MetricHistoryModal(props: {
  open: boolean;
  onClose: () => void;
  metric: MetricKey;
  ramTotalBytes: number;
  diskTotalBytes: number;
}) {
  const { open, onClose, metric, ramTotalBytes, diskTotalBytes } = props;
  const [data, setData] = useState<Point[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    void (async () => {
      try {
        const r = await fetch('/api/v1/host/metrics/history?seconds=86400', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as HistoryResponse;
        const points: Point[] = body.ts.map((t, i) => {
          const m = unpackHostMetrics(body.v[i] ?? []);
          return {
            ts: t,
            cpu: m.cpu_percent,
            ram_pct: ramTotalBytes > 0 ? (m.ram_used_bytes / ramTotalBytes) * 100 : 0,
            disk_pct: diskTotalBytes > 0 ? (m.disk_used_bytes / diskTotalBytes) * 100 : 0,
            rx: m.net_rx_bytes_per_sec,
            tx: m.net_tx_bytes_per_sec,
          };
        });
        setData(points);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [open, ramTotalBytes, diskTotalBytes]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
      <div className="w-[80vw] max-w-4xl rounded-lg border border-neutral-800 bg-neutral-950 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-300">
            {METRIC_TITLES[metric]} · 24 часа
          </h2>
          <button type="button" onClick={onClose} className="text-neutral-400 hover:text-neutral-200">✕</button>
        </div>
        {error ? (
          <div className="text-red-400">Ошибка: {error}</div>
        ) : data === null ? (
          <div className="h-72 flex items-center justify-center text-neutral-500">Загрузка…</div>
        ) : data.length === 0 ? (
          <div className="h-72 flex items-center justify-center text-neutral-500">Нет данных за 24 часа</div>
        ) : (
          <Chart metric={metric} data={data} />
        )}
      </div>
    </div>
  );
}

const METRIC_TITLES: Record<MetricKey, string> = {
  cpu: 'CPU',
  ram: 'RAM',
  disk: 'Диск',
  net: 'Сеть',
};
```

```tsx
// apps/web/src/components/MetricHistoryChart.tsx
'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricKey } from './MetricHistoryModal';

interface Point { ts: number; cpu: number; ram_pct: number; disk_pct: number; rx: number; tx: number }

export default function MetricHistoryChart({ metric, data }: { metric: MetricKey; data: Point[] }) {
  const tickFmt = (t: number) => new Date(t).toLocaleTimeString();
  if (metric === 'cpu' || metric === 'ram' || metric === 'disk') {
    const dataKey = metric === 'cpu' ? 'cpu' : metric === 'ram' ? 'ram_pct' : 'disk_pct';
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis dataKey="ts" tickFormatter={tickFmt} stroke="#666" />
          <YAxis domain={[0, 100]} unit="%" stroke="#666" />
          <Tooltip
            contentStyle={{ background: '#0a0a0a', border: '1px solid #333' }}
            labelFormatter={(t) => new Date(t as number).toISOString()}
            formatter={(v: number) => `${v.toFixed(2)}%`}
          />
          <Area type="monotone" dataKey={dataKey} stroke="#10b981" fill="#10b981" fillOpacity={0.2} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#222" />
        <XAxis dataKey="ts" tickFormatter={tickFmt} stroke="#666" />
        <YAxis stroke="#666" tickFormatter={(v: number) => `${(v / 1024).toFixed(0)} KB/s`} />
        <Tooltip
          contentStyle={{ background: '#0a0a0a', border: '1px solid #333' }}
          labelFormatter={(t) => new Date(t as number).toISOString()}
          formatter={(v: number, name: string) => [`${(v / 1024).toFixed(2)} KB/s`, name === 'rx' ? 'Вход' : 'Выход']}
        />
        <Area type="monotone" dataKey="rx" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
        <Area type="monotone" dataKey="tx" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 16.2: Typecheck the web app**

```bash
pnpm --filter @squad/web typecheck
```
Expected: PASS.

- [ ] **Step 16.3: Commit**

```bash
git add apps/web/src/components/MetricHistoryModal.tsx apps/web/src/components/MetricHistoryChart.tsx
git commit -m "feat(web): MetricHistoryModal + lazy-loaded recharts AreaChart"
```

---

## Task 17: Make dashboard cards clickable

**Files:**
- Modify: `apps/web/src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 17.1: Add modal state and convert card divs to buttons**

In `apps/web/src/app/(dashboard)/dashboard/page.tsx`:

```tsx
// add at top of component file, near other imports
import { MetricHistoryModal, type MetricKey } from '@/components/MetricHistoryModal';

// Inside the component (find the function that wraps CpuCard/RamCard/...):
const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);

// Find the JSX block where CpuCard, RamCard, DiskCard, NetworkCard are rendered.
// Wrap each card in a button:
<button type="button" onClick={() => setOpenMetric('cpu')} className="text-left">
  <CpuCard info={info} metrics={metrics} />
</button>
<button type="button" onClick={() => setOpenMetric('ram')} className="text-left">
  <RamCard metrics={metrics} />
</button>
<button type="button" onClick={() => setOpenMetric('disk')} className="text-left">
  <DiskCard metrics={metrics} />
</button>
<button type="button" onClick={() => setOpenMetric('net')} className="text-left">
  <NetworkCard metrics={metrics} />
</button>

// At the end of the component JSX:
{metrics ? (
  <MetricHistoryModal
    open={openMetric !== null}
    onClose={() => setOpenMetric(null)}
    metric={openMetric ?? 'cpu'}
    ramTotalBytes={metrics.ram_total_bytes}
    diskTotalBytes={metrics.disk_total_bytes}
  />
) : null}
```

- [ ] **Step 17.2: Typecheck**

```bash
pnpm --filter @squad/web typecheck
```
Expected: PASS.

- [ ] **Step 17.3: Manually verify in dev**

```bash
pnpm --filter @squad/web dev
```
Open `/dashboard`, click each of CPU/RAM/Disk/Net cards, confirm modal opens and chart renders or shows "Нет данных" if metrics-sampler isn't running.

- [ ] **Step 17.4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/dashboard/page.tsx
git commit -m "feat(web/dashboard): click metric cards to open 24h history modal"
```

---

## Task 18: `/logs` page

**Files:**
- Create: `apps/web/src/components/LogList.tsx`
- Create: `apps/web/src/app/(dashboard)/logs/page.tsx`

- [ ] **Step 18.1: LogList component**

```tsx
// apps/web/src/components/LogList.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveIndicator } from './LiveIndicator';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const SOURCE_CODES: Record<string, string> = {
  bridge: 'B', rcon: 'R', 'log-ingest': 'L', worker: 'W', depot: 'D', install: 'I', api: 'A',
};

interface Entry {
  id: string; ts: number; source: string; level: Level; serverId?: string; msg: string; ctx?: Record<string, unknown>;
}

export function LogList(props: { servers: Array<{ id: string; display_name: string }> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [src, setSrc] = useState<Set<string>>(new Set(Object.keys(SOURCE_CODES)));
  const [lvl, setLvl] = useState<Level>('info');
  const [srv, setSrv] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const lastIdRef = useRef<string | null>(null);

  const url = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (src.size > 0 && src.size < Object.keys(SOURCE_CODES).length) {
      p.set('src', Array.from(src).map((s) => SOURCE_CODES[s]).join(','));
    }
    p.set('lvl', lvl);
    if (srv) p.set('srv', srv);
    if (q) p.set('q', q);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/api/v1/logs?${p.toString()}`;
  }, [src, lvl, srv, q]);

  // initial load
  useEffect(() => {
    setEntries([]);
    lastIdRef.current = null;
    void (async () => {
      const r = await fetch(url(), { credentials: 'include' });
      if (!r.ok) return;
      const body = (await r.json()) as { entries: Entry[] };
      setEntries(body.entries);
      if (body.entries.length > 0) lastIdRef.current = body.entries[0].id;
    })();
  }, [url]);

  // live tail
  useEffect(() => {
    if (paused) return;
    const t = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const after = lastIdRef.current;
      if (!after) return;
      const r = await fetch(url({ after }), { credentials: 'include' });
      if (!r.ok) return;
      const body = (await r.json()) as { entries: Entry[] };
      if (body.entries.length === 0) return;
      lastIdRef.current = body.entries[0].id;
      setEntries((prev) => [...body.entries, ...prev].slice(0, 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [url, paused]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {Object.keys(SOURCE_CODES).map((s) => (
          <label key={s} className="flex items-center gap-1">
            <input type="checkbox" checked={src.has(s)} onChange={(e) => {
              const n = new Set(src);
              if (e.target.checked) n.add(s); else n.delete(s);
              setSrc(n);
            }} /> {s}
          </label>
        ))}
        <select value={lvl} onChange={(e) => setLvl(e.target.value as Level)} className="bg-neutral-900 border border-neutral-700 px-1 py-0.5">
          {LEVELS.map((l) => <option key={l} value={l}>≥ {l}</option>)}
        </select>
        <select value={srv} onChange={(e) => setSrv(e.target.value)} className="bg-neutral-900 border border-neutral-700 px-1 py-0.5">
          <option value="">все серверы</option>
          {props.servers.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск…" className="bg-neutral-900 border border-neutral-700 px-1 py-0.5" />
        <LiveIndicator paused={paused} onToggle={() => setPaused((p) => !p)} />
        <a href="/api/v1/logs/export" className="ml-auto rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700" download>⤓ Экспорт</a>
      </div>
      <ul className="font-mono text-xs space-y-0.5">
        {entries.map((e) => (
          <li key={e.id} className="flex items-start gap-2 border-b border-neutral-900 py-0.5 cursor-pointer" onClick={() => {
            const n = new Set(expanded);
            if (n.has(e.id)) n.delete(e.id); else n.add(e.id);
            setExpanded(n);
          }}>
            <span className="text-neutral-500">{new Date(e.ts).toISOString().slice(11, 23)}</span>
            <LevelPill level={e.level} />
            <span className="text-neutral-400 w-20 shrink-0">{e.source}</span>
            <span className="text-neutral-500 w-32 truncate shrink-0">{e.serverId ?? ''}</span>
            <span className="flex-1">
              {e.msg}
              {expanded.has(e.id) && e.ctx ? (
                <pre className="mt-1 whitespace-pre-wrap text-neutral-500">{JSON.stringify(e.ctx, null, 2)}</pre>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LevelPill({ level }: { level: Level }) {
  const cls = level === 'error' ? 'bg-red-900 text-red-200'
    : level === 'warn' ? 'bg-amber-900 text-amber-200'
    : level === 'info' ? 'bg-emerald-900 text-emerald-200'
    : 'bg-neutral-800 text-neutral-400';
  return <span className={`shrink-0 rounded px-1 ${cls}`}>{level.toUpperCase()}</span>;
}
```

(If `LiveIndicator` does not currently accept `paused`/`onToggle`, leave the import and use a simple `<button>` for the pause control instead. Inspect `apps/web/src/components/LiveIndicator.tsx` first and use whichever toggle pattern already exists.)

- [ ] **Step 18.2: Logs page shell**

```tsx
// apps/web/src/app/(dashboard)/logs/page.tsx
import { requirePermission } from '@/lib/dal';
import { LogList } from '@/components/LogList';
import { fetchJson } from '@/lib/fetch-json';

export const dynamic = 'force-dynamic';

export default async function LogsPage() {
  await requirePermission('host:view');
  const servers = await fetchJson<{ servers: Array<{ id: string; display_name: string }> }>(
    '/api/v1/servers',
  );
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Логи</h1>
      <p className="text-xs text-neutral-500">Последние 1000 записей из всех коннекторов панели. Обновление в реальном времени.</p>
      <LogList servers={servers.servers ?? []} />
    </div>
  );
}
```

If `requirePermission` and `fetchJson` exist with different names, adapt to the existing helpers in `apps/web/src/lib/`. Inspect the audit page (`apps/web/src/app/(dashboard)/audit/page.tsx`) for the canonical pattern.

- [ ] **Step 18.3: Typecheck**

```bash
pnpm --filter @squad/web typecheck
```
Expected: PASS.

- [ ] **Step 18.4: Commit**

```bash
git add apps/web/src/components/LogList.tsx apps/web/src/app/\(dashboard\)/logs/page.tsx
git commit -m "feat(web): /logs page with filters, live tail, export button"
```

---

## Task 19: Add nav link for Логи

**Files:**
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`

- [ ] **Step 19.1: Add the nav entry**

In `apps/web/src/app/(dashboard)/layout.tsx`, add a `<Link>` between "Журнал действий" and "Аккаунт":

```tsx
<Link href="/logs" className="block rounded px-2 py-1 hover:bg-neutral-900">
  Логи
</Link>
```

(Optionally hide it if `me.permissions` doesn't include `host:view` — match whatever pattern the existing layout uses for permission-gated links.)

- [ ] **Step 19.2: Typecheck**

```bash
pnpm --filter @squad/web typecheck
```
Expected: PASS.

- [ ] **Step 19.3: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/layout.tsx
git commit -m "feat(web/nav): add Логи link in dashboard sidebar"
```

---

## Task 20: E2E test (live stack)

**Files:**
- Create: `apps/api/test/e2e/observability.e2e.test.ts`

- [ ] **Step 20.1: Write the e2e test**

```ts
// apps/api/test/e2e/observability.e2e.test.ts
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.PANEL_TEST_URL ?? 'https://squad-panel.lan';
const COOKIE = process.env.PANEL_TEST_COOKIE;

if (!COOKIE) throw new Error('PANEL_TEST_COOKIE required for e2e');

let serverId: string;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Cookie: `__Host-sid=${COOKIE}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs = 60_000, intervalMs = 1000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('pollUntil timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('observability e2e', () => {
  beforeAll(async () => {
    // Reuse first existing server, or create a tiny one via the install lifecycle harness.
    const r = await api('/api/v1/servers');
    const list = (await r.json()) as { servers: Array<{ id: string }> };
    if (list.servers.length === 0) throw new Error('e2e expects at least one installed server');
    serverId = list.servers[0].id;
  }, 120_000);

  afterAll(() => undefined);

  it('writes bridge heartbeat lines into panel:logs', async () => {
    const entry = await pollUntil(async () => {
      const r = await api('/api/v1/logs?src=B&lvl=debug&limit=200');
      const body = (await r.json()) as { entries: Array<{ source: string; msg: string }> };
      return body.entries.find((e) => e.source === 'bridge') ?? null;
    });
    expect(entry).toBeTruthy();
  });

  it('writes rcon connector lines once a server is running', async () => {
    const entry = await pollUntil(async () => {
      const r = await api(`/api/v1/logs?src=R&srv=${serverId}&limit=200`);
      const body = (await r.json()) as { entries: Array<{ source: string; msg: string }> };
      return body.entries.find((e) => e.source === 'rcon') ?? null;
    }, 90_000);
    expect(entry).toBeTruthy();
  });

  it('serves a gzipped sectioned export bundle', async () => {
    const r = await api('/api/v1/logs/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-encoding')).toBe('gzip');
    const buf = Buffer.from(await r.arrayBuffer());
    const text = gunzipSync(buf).toString('utf-8');
    for (const section of [
      '===== BRIDGE =====',
      '===== HOST METRICS 24h (CSV) =====',
      'ts_iso,cpu_pct,ram_used',
      '===== AUDIT (last 24h) =====',
    ]) {
      expect(text).toContain(section);
    }
  });

  it('serves host metrics history as paired arrays', async () => {
    const r = await api('/api/v1/host/metrics/history?seconds=86400');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ts: number[]; v: number[][] };
    expect(Array.isArray(body.ts)).toBe(true);
    expect(Array.isArray(body.v)).toBe(true);
    expect(body.ts.length).toBe(body.v.length);
  });
});
```

- [ ] **Step 20.2: Run e2e (requires live stack)**

```bash
pnpm --filter @squad/api test:e2e -- test/e2e/observability.e2e.test.ts
```
Expected: PASS (after deploying the bundle to the test host with `worker-metrics-sampler` running).

If a section can't be exercised yet (e.g., no installed server), document it and skip with `it.skipIf(...)` rather than weakening the assertion.

- [ ] **Step 20.3: Commit**

```bash
git add apps/api/test/e2e/observability.e2e.test.ts
git commit -m "test(api/e2e): observability — heartbeat, rcon lines, export bundle"
```

---

## Task 21: Final integration sweep

- [ ] **Step 21.1: Lint, typecheck, and full test suite**

```bash
pnpm biome check --write . && pnpm turbo run typecheck && pnpm turbo run test
```
Expected: all green.

- [ ] **Step 21.2: Audit-coverage test still passes**

```bash
pnpm --filter @squad/api test test/audit-coverage.test.ts
```
Expected: PASS (no audit declarations needed; all new routes are GET).

- [ ] **Step 21.3: Manual browser smoke**

- Visit `/dashboard`. Click each of CPU / RAM / Disk / Network — modal opens, chart renders or shows "Нет данных за 24 часа" if sampler hasn't been running long.
- Visit `/logs`. Confirm filter buttons, level dropdown, server dropdown, search box all narrow the list. Confirm new entries appear within ~1 second after a manual action that produces one (e.g., restart bridge → see `down`/`recovered` warns).
- Click "⤓ Экспорт", confirm a `panel-logs-*.txt.gz` downloads, gunzip it, confirm sections present and CSV is plottable.

- [ ] **Step 21.4: Run the full e2e suite**

```bash
pnpm --filter @squad/api test:e2e
```
Expected: `install-lifecycle.e2e.test.ts`, `bridge-rpc.e2e.test.ts`, and the new `observability.e2e.test.ts` all PASS.

- [ ] **Step 21.5: Final commit (if any uncommitted formatting)**

```bash
git status
git add -p
git commit -m "chore: post-implementation lint sweep" || true
```

---

## Done criteria (per spec §11)

- `pnpm turbo run typecheck` green.
- `pnpm turbo run test` green (incl. all new unit + integration suites).
- `pnpm --filter @squad/api test:e2e` green (incl. new `observability.e2e.test.ts`).
- Manual browser verification on `/logs` and on the four dashboard cards.
- `audit-coverage.test.ts` still green.
- No regressions on `install-lifecycle.e2e.test.ts`.
