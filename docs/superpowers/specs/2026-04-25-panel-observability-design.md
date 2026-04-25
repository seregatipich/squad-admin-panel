# Panel Observability — Connector Logs, Metrics History, Export

**Status:** Design approved 2026-04-25 · awaiting implementation plan
**Owner:** poluektovsergei345@rebels.ai
**Scope tags:** logging, metrics, dashboard, export, RBAC

## 1. Goal

Give operators a complete, diagnosable picture of what the panel itself is doing — every connector's connection state, every transition, every retry — without drowning Postgres or breaking existing log paths. Plus a 24h history graph for the four host-metric cards on the dashboard, plus a single-file export bundle covering everything for off-host triage.

Three deliverables:

1. **Verbose connector logs** for bridge, RCON, log-ingest, workers, depot/install, and API, written to a capped Redis Stream `panel:logs` in addition to today's stdout/journald path.
2. **Host metrics history** sampled every 15s for 24h, surfaced through click-to-expand modals on the existing CPU/RAM/Disk/Network dashboard cards.
3. **Logs page** at `/logs` (live tail + filter) and an **export endpoint** that streams a single sectioned, gzipped `.txt`.

All three sit on existing infrastructure (Redis, pino, Fastify, Drizzle/Postgres, Next App Router) — no new datastores.

## 2. Non-goals

- Long-term log retention. 24h+ in-stream is enough; if more is needed, the existing `worker-audit-archiver` pattern can be copied in a future sub-project.
- Histograms / aggregations / alerting / Prometheus exposition. Out of scope; this is for human eyes and ad-hoc download.
- Replacing `audit_log`. Audit stays in Postgres with its hash chain. The export bundle includes a recent slice for convenience but the canonical record is unchanged.
- Replacing the existing per-server live `docker logs` view at `/servers/:id/logs`. That stays. Squad game logs only enter the export bundle as a one-shot 24h tail.

## 3. Architecture

```
                                    +---------------------------+
        bridge-client / supervisor  |  pino logger (stdout)     |  ── journald / docker logs (unchanged)
        rcon supervisor             |                           |
        log-ingest tail             |  + log-stream side-channel|  ── Redis Stream `panel:logs`
        workers / depot / install   |  XADD MAXLEN ~ 100000     |
                                    +---------------------------+

        worker-metrics-sampler  ── bridge.host_metrics every 15s ──> Redis Stream `host:metrics`
                                                                     (MAXLEN ~ 5760, packed int8 array)

        Next dashboard cards ──> click ──> modal w/ recharts <AreaChart>
        Next /logs page      ──> XREVRANGE backfill + 1s poll for tail
        GET /api/v1/logs/export ──> gzipped sectioned text bundle
```

### 3.1 Privilege & RBAC

| Surface | Required permission | Notes |
|---|---|---|
| `GET /api/v1/logs` (list, filtered) | `host:view` | Existing key |
| `GET /api/v1/logs/export` | `host:metrics` | Bulk dump; gated stricter |
| `GET /api/v1/host/metrics/history` | `host:metrics` | Existing key |
| `/logs` page | `host:view` (link visible if granted) | Renders client-side; server checks on every fetch |

No new permission keys. The existing `host:view` / `host:metrics` split already matches "view current" vs "pull bulk data".

## 4. Storage encoding

### 4.1 `panel:logs` Redis Stream

Single stream, capped: `XADD panel:logs MAXLEN ~ 100000 * <fields>`. Approximate trimming (`~`) for write throughput. Stream ID's millisecond prefix IS the timestamp — no separate `ts` field stored.

Per-entry fields (all values are Redis Stream string fields):

| Key | Encoding | Meaning |
|---|---|---|
| `s` | 1-byte char | Source: `B` bridge · `R` rcon · `L` log-ingest · `W` worker · `D` depot · `I` install · `A` api |
| `l` | 1-byte char | Level: `D` debug · `I` info · `W` warn · `E` error |
| `i` | uuid string | Server id. **Field omitted entirely** when null. |
| `m` | utf-8 string | Short deterministic message. Convention: `<verb>: <object> <key=val ...>` with no PII. |
| `c` | json string | Optional structured context. **Field omitted entirely** when caller passes nothing. |

Avg expected entry size: 70–120 bytes. 100k cap × 120 B = ~12 MB upper bound in Redis. At expected steady-state log rate (~5 entries/sec across the whole panel) the cap covers ~5–6h; bursts (install, depot update) trim older entries quietly via `MAXLEN ~`.

A small encoder/decoder lives in `packages/shared-config/src/log-stream.ts`:

```ts
export type LogSource = 'bridge' | 'rcon' | 'log-ingest' | 'worker' | 'depot' | 'install' | 'api';
export type LogLevel  = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry { ts: number; source: LogSource; level: LogLevel; serverId?: string; msg: string; ctx?: Record<string, unknown>; }

export function encode(e: Omit<LogEntry, 'ts'>): Record<string, string>;        // for XADD
export function decode(id: string, fields: Record<string, string>): LogEntry;   // from XREVRANGE / XREAD
```

### 4.2 `host:metrics` Redis Stream

`XADD host:metrics MAXLEN ~ 5760 * v <packed>`.

`<packed>` is a JSON array of 8 integers, no field names:

```
v = [cpu_pct_x100, ram_used_bytes, disk_used_bytes, rx_bps, tx_bps, la1_x100, la5_x100, la15_x100]
```

Percentages multiplied by 100 to round-trip 2 decimals as integers. JSON string `[7351,1234567890,55667788,1234,567,53,71,89]` is ~50 bytes. 5,760 entries × 50 B ≈ 300 KB total.

Total RAM/disk metric pair (`ram_total_bytes`, `disk_total_bytes`) is not sampled — these are stable host facts and come from `/api/v1/host/info`. Saves 16 bytes per sample.

Encoder lives in `packages/shared-config/src/metrics-pack.ts`.

### 4.3 Compression of the export download

The export endpoint negotiates `Content-Encoding: gzip` and streams gzipped text. Filename `panel-logs-<iso8601>.txt.gz`. Per-record gzip would be wasteful (header overhead exceeds payload for sub-100-byte records); gzip on the bundle gets the wins where they exist (long repeated lines, CSV blocks).

## 5. Connector log emission

The existing pino loggers in api / workers stay as-is. A side-channel writes the same record to `panel:logs` via `log-stream.encode()`. Implementation:

- `packages/shared-config/src/log-stream.ts` exports `attachStreamSink(logger, redis, defaultSource)` that adds a sink to pino via `pino.multistream([{ stream: process.stdout }, { stream: redisXaddWritable(redis, defaultSource) }])`. The Redis writable parses each pino line, calls `redis.xadd('panel:logs', 'MAXLEN', '~', '100000', '*', ...)`, and is best-effort: ENOENT/CONNREFUSED is logged once via stdout-only and swallowed (no log loop).
- `apps/api/src/server.ts`, `apps/workers/*/src/index.ts` each call `attachStreamSink(app.log, app.redis, '<source>')` once at boot.

### 5.1 Verbose lines added (the "log everything" requirement)

| Source | New lines (pino + Redis stream) |
|---|---|
| **Bridge client** (`packages/bridge-client/src/client.ts`) | `connect: <socket>` · `connected v=<ver> host=<name>` · `decode-error: <err>; reset` · `rpc <method> <ms>ms <ok|err: …>` · heartbeat (debug) `alive rtt=<ms>ms` · heartbeat (warn) `down: <err>` |
| **Bridge heartbeat** (new, `apps/api/src/plugins/bridge.ts`) | A 5s `setInterval` calls `bridge.ping()`. Logs only on transition (alive→down emits warn, down→alive emits info `recovered after <s>s`) plus a debug heartbeat every tick. |
| **RCON supervisor** (`apps/workers/rcon/src/supervisor.ts`) | `connect <host:port>` · `auth ok` · `auth failed: <reason>` · `poll listplayers <ms>ms n=<count>` · `keepalive showserverinfo ok` · `disconnect: <reason>` · `reconnect in <ms>ms backoff=<n>` |
| **Log-ingest tail** (`apps/workers/log-ingest/src/tail.ts`) | `tail start container=<name>` · `tail bytes/min=<n>` (debug, every 60s) · `parser miss <line[0..32]>` (debug, sampled) · `tail dropped → restart` (warn) |
| **Workers (all)** (via `packages/shared-config/src/heartbeat.ts`) | `heartbeat publish ok` (debug) · `heartbeat publish fail: <err>` (warn) · `slow tick <ms>ms` (warn, when tick > 2× expected) |
| **Depot / install** | Already streams to per-server channels. Mirror those into `panel:logs` so they land in the export bundle. |
| **API** | 5xx route response · RBAC denial (debug) · audit write failure (error) |

Verbosity is `info` by default. `LOG_LEVEL=debug` in env flips api/workers to debug, which floods the heartbeat lines. The Redis stream sink obeys the same level.

## 6. Host metrics history

A new tiny worker `apps/workers/metrics-sampler/`:

- `setInterval(15_000)` calls `bridge.hostMetrics()`.
- Packs the 8 values via `metrics-pack.encode()`, XADDs to `host:metrics` with `MAXLEN ~ 5760`.
- Heartbeats under `worker:heartbeat:metrics-sampler`.
- On bridge failure, logs `metrics sample failed: <err>` (warn) and continues — doesn't backfill gaps. Gaps in the chart are honest signal.

`GET /api/v1/host/metrics/history?seconds=86400` returns paired arrays for minimal wire size (no repeated keys):

```json
{ "ts": [1735900000000, 1735900015000, ...], "v": [[7351, 1234567890, 55667788, 1234, 567, 53, 71, 89], ...] }
```

The response stays packed integers (cpu/load multiplied by 100). Client decodes once into the recharts data shape at modal mount.

## 7. UI

### 7.1 Click-to-expand metric cards

`apps/web/src/app/(dashboard)/dashboard/page.tsx` — convert `CpuCard`, `RamCard`, `DiskCard`, `NetworkCard` from `<div>` to `<button>` with `aria-expanded` / `aria-controls`. On click, open a modal (existing modal pattern in repo, or a new `MetricHistoryModal` if none) containing a `recharts <AreaChart>` of the last 24h. Modal lazy-loads `recharts` (dynamic import) so the dashboard initial bundle doesn't grow.

- **CPU**: single area, `cpu_pct`. Y-axis 0–100.
- **RAM**: single area, `ram_used_bytes / ram_total_bytes × 100`. Y-axis 0–100.
- **Disk**: single area, same shape as RAM.
- **Network**: two stacked areas, `rx_bps` and `tx_bps`. Y-axis bytes/s, log-ish formatter.

X-axis is the stream ts. Tooltip shows formatted value + ISO timestamp.

### 7.2 `/logs` page

`apps/web/src/app/(dashboard)/logs/page.tsx`. Layout:

```
[Source ☐ bridge ☐ rcon ☐ log-ingest ☐ worker ☐ depot ☐ install ☐ api]
[Level: ☐ debug ☐ info ☐ warn ☐ error]   [Server: <select>]   [Search: ____]   [LiveIndicator]   [⤓ Export]

ts          src   level   server  msg                                  [▸ ctx]
21:04:55.121 R    INFO    Alpha   poll listplayers 14ms n=12
21:04:55.087 B    DEBUG   —       alive rtt=2ms
...
```

- Default filter: all sources, level ≥ info, all servers, last 500 entries.
- Newest on top. Color-coded level pill.
- Click row → expand inline `c` JSON pretty-printed.
- Live tail: 1s `setInterval` calling `GET /api/v1/logs?after=<last_seen_id>`. Pauses when tab hidden (existing `LiveIndicator` already handles visibility).
- "Older" button at list bottom calls `GET /api/v1/logs?before=<oldest_id>&limit=200`.
- Filters are URL state (`?src=B,R&lvl=I&srv=<uuid>`) so links are shareable.

### 7.3 Export

`GET /api/v1/logs/export` (auth: `host:metrics`). `Content-Type: text/plain; charset=utf-8`, `Content-Encoding: gzip`, `Content-Disposition: attachment; filename="panel-logs-<iso>.txt.gz"`.

Sections, in order:

```
===== EXPORT panel-logs <iso8601-now> · panel <version> · host <hostname> =====
===== BRIDGE =====
<all panel:logs entries where s=B, oldest first>

===== RCON server "Alpha" (<uuid>) =====
<entries where s=R AND i=<uuid>>

===== RCON server "Bravo" (<uuid>) =====
...

===== LOG-INGEST server "Alpha" (<uuid>) =====
...

===== WORKERS =====
<entries where s=W>

===== DEPOT / INSTALL =====
<entries where s=D OR s=I>

===== API =====
<entries where s=A>

===== HOST METRICS 24h (CSV) =====
ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15
2026-04-24T21:00:00Z,73.51,1234567890,55667788,1234,567,0.53,0.71,0.89
...

===== AUDIT (last 24h) =====
<select * from audit_log where created_at > now()-1d order by id; redact rcon_password etc — same redaction list as pino>

===== SQUAD GAME LOGS server "Alpha" (<uuid>) =====
<bridge container_logs_follow squad-<uuid> with `since=24h` (one-shot tail)>

===== SQUAD GAME LOGS server "Bravo" (<uuid>) =====
...
```

Each entry line format:
```
<iso ts> <level-3char> [<source>] [<server-name?>] <msg>  ctx={...}
```

Stream is built incrementally — never holds full bundle in memory. For each section: open a Redis cursor (`XREVRANGE` paged) or DB cursor, write to the gzip stream, flush, move on.

### 7.4 Nav

A "Логи" link in the existing dashboard layout (`apps/web/src/app/(dashboard)/layout.tsx`), shown if the current user has `host:view`. UI copy stays Russian per CLAUDE.md.

## 8. Testing

### 8.1 Unit (vitest)

- `packages/shared-config/test/log-stream.test.ts` — encode/decode round-trip, omits empty fields, rejects bad enums.
- `packages/shared-config/test/metrics-pack.test.ts` — pack/unpack symmetry for boundary values (0, max int53).
- `apps/workers/metrics-sampler/test/sampler.test.ts` — fake clock, fake bridge; asserts XADD happens at 15s, not on bridge error.

### 8.2 Integration (Fastify `inject()`, real Redis via testcontainer or local)

- `apps/api/test/logs-list.test.ts` — seed `panel:logs`, query `/api/v1/logs?src=R&lvl=I&srv=<uuid>`, assert filtering + pagination.
- `apps/api/test/logs-export.test.ts` — seed `panel:logs` + `host:metrics` + 1 audit row + a fake bridge container_logs response. Hit `/api/v1/logs/export`, gunzip, assert all sections present in order, header lines present, redaction applied.
- `apps/api/test/metrics-history.test.ts` — seed `host:metrics`, hit `/api/v1/host/metrics/history`, assert packed payload + count.
- `apps/api/test/bridge-heartbeat.test.ts` — start api, kill bridge process, wait 6s, assert a `bridge: down` warn entry hits `panel:logs`.
- `apps/api/test/audit-coverage.test.ts` — already exists, no changes required. All new routes are GET (list, history, export), so no `config.audit` declarations are needed and the existing scan must keep passing.

### 8.3 E2E (`apps/api/test/e2e/observability.e2e.test.ts`)

- Create a server, install it, wait for status running.
- Wait until `/api/v1/logs?src=R` shows ≥1 `auth ok` row and `/api/v1/logs?src=B` shows ≥1 heartbeat.
- `GET /api/v1/logs/export` → gunzip → assert headers `===== BRIDGE =====`, `===== RCON server "<name>" (<uuid>) =====`, `===== HOST METRICS 24h (CSV) =====` are all present, in order, and the CSV has ≥1 data row.
- Tear down (server stop + delete).

### 8.4 Web component (vitest + RTL)

- `apps/web/src/components/MetricHistoryModal.test.tsx` — given a mocked history payload, the modal renders without throwing and shows a path with the right number of segments. (We don't snapshot recharts SVG; we assert the data prop wiring.)
- `apps/web/src/app/(dashboard)/logs/page.test.tsx` (or component test) — filter narrows visible rows.

## 9. Migration / rollout

No DB migrations. No new permission keys. New Redis keys (`panel:logs`, `host:metrics`) are created on first XADD and capped on every write — safe to deploy alongside existing data.

The new worker `worker-metrics-sampler` is added to `docker-compose.yml` alongside the others. If it's not running, the metrics modals show "no data yet" — graceful degrade.

The pino side-channel is best-effort: if Redis is down, panel logs fall through to journald only, no exceptions propagate.

## 10. Decisions locked in

- **History API response shape:** paired arrays `{ ts: number[], v: number[][] }`. Smaller wire size than `[{ts,v}]` (no repeated keys). Client decodes once into a recharts-friendly array of objects.
- **recharts:** add as a dependency of `apps/web` only, lazy-loaded inside `MetricHistoryModal` via `dynamic(() => import('recharts'))`. No effect on dashboard initial paint.
- **Live-tail strategy:** simple 1s poll on `XREVRANGE`, matching the existing dashboard polling pattern (`POLL_MS = 4000` in dashboard page). Blocking `XREAD` is fancier but adds a long-lived per-tab Redis connection; not worth it for "minimal".

## 11. Stop-ship criteria

Per CLAUDE.md mandatory checklist:

- `pnpm turbo run typecheck` green.
- `pnpm turbo run test` green (includes new unit + integration suites).
- `pnpm --filter @squad/api test:e2e` green (includes new `observability.e2e.test.ts`).
- Manual browser verification on `/logs` and on the four dashboard cards: filters work, export downloads, modal renders chart with data.
- `audit-coverage.test.ts` still green.
- No regressions on `install-lifecycle.e2e.test.ts`.
