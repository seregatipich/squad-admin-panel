# Diagnostic Bundle & Panel Disk Breakdown — Design

Status: **Draft** (brainstormed 2026-04-28)
Owner: TBD (assign at implementation time)
Related work: `docs/superpowers/specs/2026-04-25-panel-observability-design.md` (parent observability epic)

## 1. Goal

Operator can answer three questions without ssh and without a dedicated page for each:

1. **«что произошло» / «что было до отключения»** — reconstruct a 5-minute timeline of panel-internal events around any unexpected shutdown (Squad container exit, bridge disconnect, worker heartbeat lost, RCON auth fail, panic).
2. **«почему панель странно себя ведёт сейчас»** — dump current connector state + recent error/warn stream of every panel component, ready to paste into a coding agent.
3. **«сколько диска ест панель против всего остального»** — see panel-owned storage broken out from total host disk usage, with per-server detail one click away.

The deliverable is **two minimally-invasive UI changes** (a topbar diagnostics popover + a sub-segment on the existing disk widget) and the supporting backend.

## 2. Non-goals

- No external observability stack (Loki/Grafana/ELK). That is a separate initiative tracked in `2026-04-25-panel-observability-design.md`.
- No Squad-game internals. Squad container and `SquadGame.log` are tapped **only for `Warning|Error|Fatal|LogExit` lines** as supporting context for incidents — never as a content source.
- No tamper-evident hash chain on diagnostic events. That role is owned by `audit_log` and is unchanged here.
- No per-server diagnostic bundle. Bundle is global only.
- No new dedicated page in the web app. Both features sit on top of existing surfaces.

## 3. Architecture

### 3.1 Storage: `diagnostic_events` table

New Postgres table. Partitioned by day, retention **24 hours**, drop policy added to existing `worker-event-partition` (which already rotates `events` partitions).

```sql
CREATE TABLE diagnostic_events (
  id            uuid PRIMARY KEY,                 -- uuid v7, sortable by time
  ts            timestamptz NOT NULL,
  component     text NOT NULL,                    -- 'api' | 'bridge' | 'reconciler' | 'worker-rcon' | …
  severity      text NOT NULL,                    -- 'debug'|'info'|'warn'|'error'|'fatal'
  kind          text NOT NULL,                    -- 'container.exited' | 'rcon.auth_failed' | …
  server_id     uuid NULL REFERENCES servers(id),
  actor_steam_id64 text NULL,
  request_id    text NULL,
  message       text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (ts);
CREATE INDEX ON diagnostic_events (ts DESC);
CREATE INDEX ON diagnostic_events (server_id, ts DESC);
CREATE INDEX ON diagnostic_events (component, severity, ts DESC);
```

**`UPDATE` and `DELETE` are explicitly allowed** (unlike `audit_log`). The wipe button truncates the table; the daily worker drops partitions older than 24h.

### 3.2 Helper: `packages/diag`

Single function:

```ts
diag.emit({
  component: string,
  kind: string,
  severity: 'info' | 'warn' | 'error' | 'fatal',
  server_id?: string,
  actor_steam_id64?: string,
  request_id?: string,
  message: string,
  payload?: Record<string, unknown>,
});
```

Implementation:
- Pushes to Redis Stream `diag:queue` (XADD with MAXLEN ~ 100k cap as safety net).
- A new lightweight worker `worker-diag-flush` consumes the stream, batches `INSERT INTO diagnostic_events` 100 rows / 1 second, ACKs.
- Fallback: if Redis is unavailable, `diag.emit` falls back to `pino.warn({ diag_event: … })` so nothing is silently dropped.
- Mirror to pino at the same severity (so `docker logs` of each component still shows the event live for tail-style debugging during incidents).

The Go bridge gets a sibling implementation that writes JSON lines to journald with a `DIAG_EVENT=1` field; an exporter inside `worker-diag-flush` reads `journalctl -u panel-host-bridge -o json --since "30s ago" -f` (or via the bridge itself emitting to the same Redis stream — chosen at impl time).

### 3.3 Sources (instrumentation points)

These are the **panel-internal** events captured. Squad-game internals are deliberately excluded except for the narrow Warning/Error/Fatal/LogExit pull on demand inside the bundle builder.

| Component | Events emitted |
|---|---|
| `api` (server lifecycle) | `server.install.{requested,depot_seed,ufw_rule,container_run,verify,done,failed}`, `server.start.{requested,done,failed}`, `server.stop.{requested,broadcast,end_match,container_stop,reconciler_confirmed,done,failed}`, `server.soft_delete.{requested,done}`, `server.restore.{requested,done}` |
| `reconciler` | `container.status_change` (with `from`,`to`), `container.exited` (`exit_code`,`signal`,`oom_killed`,`finished_at`), `container.unexpected_exit` (no preceding `server.stop.requested`) |
| `panel-host-bridge` (Go) | `bridge.client.{connected,disconnected}`, `bridge.rpc.error`, `bridge.panic`, `bridge.signal.sigterm`, `bridge.host_agent_restart`, `bridge.rtt.outlier` (RTT > 50ms) |
| `db` connector (api) | `pg.ping.{ok,fail}` (only fail + first ok-after-fail), `pg.reconnect.{attempt,success,fail}`, `pg.query.timeout` |
| `redis` connector (api+workers) | `redis.ping.{fail}`, `redis.reconnect.{attempt,success,fail}` |
| `worker-rcon` | per-target `rcon.{connected,auth_failed,disconnected,reconnect_attempt}`, `rcon.targets.changed` (count delta), `rcon.command.timeout` (manual cmds only — auto poll is excluded) |
| `worker-log-ingest` | per-server `tail.{started,stopped,parser_error}`, `tails.changed` (count delta), `squad.log.fatal` (parsed Fatal/LogExit line — surfaced as `kind:'squad.log.fatal'` so it shows in incidents) |
| `worker-audit-archiver` | `archiver.{started,stopped,run_ok,run_failed}` |
| `worker-event-partition` | `partition.{rotated,drop_failed}` |
| All workers | `worker.heartbeat_lost` (TTL key absent > 30s — emitted by api when it observes the gap) |
| api WS clients | `ws.{connected,disconnected}` per route (`/live-bus`, `/install/:id`, `/logs/:id`) with `reason` and `code`; `ws.frame_drop`, `ws.decode_error` |
| `audit_log` ↔ `diagnostic_events` | for each new `audit_log` row, emit `kind:'audit'` with `payload:{audit_log_id}` — body is NOT duplicated, only the pointer |
| api HTTP layer | `http.5xx`, `http.unhandled_rejection`, `http.route_timeout` |
| `Squad container` | **on demand only** in bundle builder: tail `SquadGame.log` and `docker logs squad-*` filtered to `Warning|Error|Fatal|LogExit` for the current window. Not stored in `diagnostic_events` proactively. |

### 3.4 Bundle endpoint

`GET /api/v1/host/diagnostics/bundle?window=15m|1h|6h|24h`

- **RBAC:** `host:manage`
- **Throttle:** 30s per user (return 429 with `retry_after`)
- **Cache:** Redis key `diag:bundle:{window}` TTL 30s — concurrent tabs share a build
- **Output:** `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="squad-panel-diag-{hostname}-{YYYYMMDD-HHMMSS}-{window}.md"`
- **Hard size cap:** 400 KB. Builder targets ≤ 350 KB; if rendered output exceeds 400 KB, oldest entries in §6 → §5 → §4 are dropped (in that order) and a `[truncated: …]` line is appended to §7.
- **Default window:** `1h` (sized so that on a typical install the full bundle fits without truncation).

**Sections (rendered in this order):**

| § | Section | Approx size | Content |
|---|---|---|---|
| 0 | State snapshot | ~2 KB | containers (id/status/image/started/last_exit), workers (name/heartbeat_age/status), depot (build_id/last_update/volume_size), bridge (connected/version/rtt), pg/redis ping, disk free, ufw active rules |
| 1 | Incidents | up to ~150 KB | Reconstructed timeline blocks, see §3.6. **All incidents in window, no cap.** |
| 2 | Errors & warnings (dedup) | ~10 KB | `[count] [first_seen] [last_seen] [component] [kind] [message]` with one payload sample. Dedupe by `(component, kind, message)` — count repetitions, do not list duplicates. |
| 3 | Audit log | up to ~25 KB | All `audit_log` rows in window: `ts | actor | action | resource | result | ip` |
| 4 | Lifecycle events | up to ~100 KB | All `diagnostic_events` rows in window: `ts | component | severity | kind | server | message` |
| 5 | Per-server briefs | up to ~80 KB | for each server active in window: status, last_started, last_exit (`exit_code`, `signal`, `oom_killed`), last config edit (file/sha7/author), Squad log Warning/Error count, **Warning/Error tail (filtered, max 30 lines per server)** |
| 6 | Component log tails | up to ~80 KB | pino logs (api + each worker, errors+warns, last 30 each); bridge journald (errors only, last 30) |
| 7 | Truncation report | <1 KB | what was dropped to fit cap |

Body is plain Markdown — fenced code blocks for tables/code, plain text for log lines. No JSON inside bundle (Markdown renders better in coding agents).

### 3.5 Wipe endpoint

`POST /api/v1/host/diagnostics/wipe`

- **RBAC:** `host:manage`
- Behaviour: `TRUNCATE diagnostic_events` + drop daily partitions under it + `XTRIM diag:queue MAXLEN 0`
- The wipe itself is recorded in `audit_log` with `action:'host.diagnostics.wipe'` so the operator history is preserved
- Returns `{ ok: true, removed_rows: N, removed_partitions: M }`

### 3.6 Incident reconstruction (§1 in bundle)

For every event in the window matching the **trigger set**, the builder produces one incident block.

**Trigger set:**

| `kind` | condition |
|---|---|
| `container.exited` | `payload.exit_code != 0` OR `payload.oom_killed = true` OR exit with no preceding `server.stop.requested` for same `server_id` within 5 min (= `container.unexpected_exit`) |
| `bridge.client.disconnected` | not preceded by `bridge.host_agent_restart` within 30s |
| `worker.heartbeat_lost` | any |
| `rcon.auth_failed` | any |
| `squad.log.fatal` | parsed Fatal/LogExit/Assertion line emitted by `worker-log-ingest` |
| `bridge.panic` / `http.unhandled_rejection` | any |

**Per-incident block content:**

```markdown
### incident-N — <short subject>
classification: <heuristic_label>
trigger: <kind>
context window: <T-5m> → <T> (UTC)

#### timeline (merged, all components)
[ts] component   kind                     details (single line)
…

#### preceding RCON (last commands in window, manual only)
[ts] actor   command                      → result_summary

#### preceding config edit
file | author | sha7 | ts ; diff vs prior (one line summary)
restart_required: yes/no

#### host metrics window
cpu/ram/swap/net min/avg/max for [T-5m, T]

#### squad log Warning/Error/Fatal/LogExit (last 50 lines in window)
…

#### docker logs tail (last 30 lines in window)
…
```

**Classification heuristic** (label rendered at top of each block):

| label | predicate |
|---|---|
| `user_initiated_stop` | preceding `server.stop.requested` from same server in window |
| `probable_oom` | `oom_killed = true` OR `mem >= 0.95 * limit` for ≥1 min before exit |
| `crash_segfault` | `signal in ('SIGSEGV','SIGABRT')` |
| `assertion_failure` | `Assertion failed:` in squad log within window |
| `deadlock_or_hang` | no new squad log lines for ≥30s before exit |
| `host_resource_exhaustion` | swap > 0 OR disk_free < 1 GB during window |
| `bridge_lost` | `bridge.client.disconnected` overlaps window |
| `unknown` | none of the above |

**Grouping:** if two incidents are within 60s of each other and share `server_id`, they merge into one block (e.g. `container.exited` + `bridge.client.disconnected` from the same server in the same minute = one incident, both triggers listed).

**Cap:** none. All incidents in window are emitted. Per-block hard size cap **6 KB**; if a block would exceed, squad log tail is the first thing trimmed.

### 3.7 Redaction (applied to every bundle)

- `Rcon.cfg` content is **never included** (only sha + last-edit metadata).
- Regex-strip in any rendered string: `password=…`, `Password=…`, `RconPassword=…`, `Bearer\s+\S+`, `__Host-sid=\S+`. Replaced with `***REDACTED***`.
- Steam IDs are NOT masked — needed for ban/role debugging.
- Admin IP addresses are NOT masked — operator already sees them in audit.

### 3.8 Disk breakdown

**New bridge RPC: `panel_disk_usage`**

Return shape:

```ts
{
  configs_bytes: number;                                            // /var/lib/squad-panel/configs total
  saved_total_bytes: number;                                        // /var/lib/squad-panel/saved total
  saved_per_server: { uuid: string; bytes: number }[];              // each /var/lib/squad-panel/saved/<uuid>
  depot_volume_bytes: number;                                       // squad-depot named volume
  docker_volumes: { name: string; bytes: number }[];                // squad-panel_pg-data, squad-panel_redis-data
  docker_images: { repository: string; tag: string; bytes: number }[]; // squad-server, depot-init, panel api/web/worker
  audit_archive_bytes: number;                                      // /var/lib/squad-panel/audit-archive (0 if unused)
  total_panel_bytes: number;                                        // sum of the above
  host_total_bytes: number;                                         // statvfs of /var/lib/squad-panel mount
  host_used_bytes: number;
  computed_at: string;                                              // ISO timestamp
  cache_age_seconds: number;
}
```

Implementation:
- `du -sb` over each allowlisted root (`/var/lib/squad-panel/configs`, `/var/lib/squad-panel/saved`, `/var/lib/squad-panel/audit-archive`)
- `docker system df --format json` + filter to panel-owned images and volumes
- `statvfs("/var/lib/squad-panel")` for total/used host disk
- Bridge-side cache: 5 minutes TTL (`du` is heavy on large `saved` trees)

Path/volume/image allowlist enforcement is identical to existing bridge methods — no shell injection, no globs.

**New API endpoint: `GET /api/v1/host/disk-usage`**

- RBAC: `host:view`
- audit: false (read-only, expensive but not sensitive)
- Wraps the bridge call; computes derived `panel_pct = total_panel_bytes / host_total_bytes` and `other_pct = (host_used_bytes - total_panel_bytes) / host_total_bytes`
- API-side cache: 60s

**UI changes (existing dashboard disk widget, `apps/web/src/app/(dashboard)/dashboard/page.tsx`):**

- Disk widget renders the existing horizontal bar (currently single segment colored by used%). Add a **second sub-segment in a distinct color** representing `panel_used / host_total`. Both segments together still equal the existing `used / host_total = 23.2%` value — the sub-segment is a slice INSIDE the used portion, not in addition to it. Legend below the bar: small `■ Панель X.X% · ■ Прочее Y.Y%`. Numbers must always sum to the displayed total.
- **Click on the disk widget** opens an existing-style modal (similar to `MetricHistoryModal`) titled «Что занимает панель»:
  - Donut chart: configs / saved / depot volume / pg volume / redis volume / docker images / audit archive
  - Sortable table «по серверам»: display name | configs MB | saved GB | total. Clicking a row navigates to `/servers/[id]`.
  - Footer: `Обновлено N сек назад` + ↻ refresh button (force-bypasses both API and bridge cache)

No other surfaces are touched.

## 4. UI

### 4.1 Diagnostics popover (new)

Lives in `apps/web/src/app/(dashboard)/layout.tsx` topbar, rendered next to the user menu. Icon button (lucide `Bug` or `FileText`) with tooltip «Диагностика». Visible only to users with `host:manage` (gated client-side, enforced server-side).

Click opens a small popover (existing `Popover` primitive):

```
Диагностика

Окно:  ( ) 15 минут
       (•) 1 час
       ( ) 6 часов
       ( ) 24 часа

[ Скачать .md ]

—

[ Очистить логи ]   ← red, requires confirm
```

- **Скачать**: triggers `GET /api/v1/host/diagnostics/bundle?window=...` with `responseType: blob`; browser saves the file. Loading state on button; error toast on 4xx/5xx.
- **Очистить логи**: confirm modal («Удалит все диагностические события за последние 24 часа. Восстановить нельзя. audit_log не трогается.») → `POST /api/v1/host/diagnostics/wipe`. On success: toast «Очищено N событий», popover stays open.

### 4.2 Disk widget extension

Already specified in §3.8 above. Visual change is one extra sub-segment in the existing bar; no new card, no new page.

## 5. Phases

Two parallel tracks that share Phase 1+2 as foundation.

**Track A — Diagnostic bundle**

| Phase | Scope | Depends on |
|---|---|---|
| **A1. Storage + helper** | Migration: `diagnostic_events` table + indexes + 24h drop policy in `worker-event-partition`. New package `packages/diag`. New worker `worker-diag-flush` (Redis Stream → batched INSERT). | — |
| **A2. Instrumentation** | Wire `diag.emit` into all sources listed in §3.3. Bridge-side journald → diag stream exporter. Audit-coverage test extension: any route that flips `server.status` must emit a corresponding `server.*` diag event. | A1 |
| **A3. Bundle endpoint** | `apps/api/src/routes/diagnostics.ts`: builder for §0–§7 with redaction, 400 KB cap with truncation report, Redis cache. New bridge RPC `file_read_tail` (offset-from-end + max_bytes) used to read `SquadGame.log` without slurping multi-MB files. Wipe endpoint. Unit tests per section, golden test against a fixed event fixture. | A2 |
| **A4. Incident builder (§1)** | Trigger detection, T-5min context window query, classification heuristic, grouping. Plug into bundle builder behind a feature flag (`diag.incidents_enabled` env, default true once stable). | A3 |
| **A5. Diagnostics popover UI** | `<DiagnosticsMenu>` in topbar layout. Radio + Скачать + Очистить. RBAC gating client-side. Confirm modal on wipe. Playwright e2e: click → blob → structure assertion. | A3 (A4 optional but desired) |

**Track B — Panel disk breakdown**

| Phase | Scope | Depends on |
|---|---|---|
| **B1. Bridge RPC + API endpoint** | New bridge RPC `panel_disk_usage` (impl + allowlist + 5-min cache + tests). Updates to `bridge-methods.ts`, `bridge-client/src/client.ts`, Go handlers (3-source-of-truth invariant). New API route `GET /api/v1/host/disk-usage` with 60s cache. | — (parallel to A1) |
| **B2. Dashboard disk widget extension** | Add panel sub-segment inside the existing used-portion of the bar; legend below; click handler. RBAC: visible to anyone who already sees the dashboard. | B1 |
| **B3. Disk breakdown modal** | `<DiskBreakdownModal>` (donut by type + sortable per-server table + refresh button). Linked from B2 click handler. | B2 |

Track A and Track B are independent. Either can ship first. A1+A2 are mandatory before A3; B1 is mandatory before B2; B3 is the polish step on B.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| INSERT throughput from spammy components (worker-rcon target loop) burns Postgres | Redis Stream buffer + batching worker; severity-based dropping if backlog > 50k; explicit no-emit policy on auto-poll RCON commands |
| `du -sb` on a 50+ GB `saved` tree is slow | Bridge caches result 5 min; API caches 60s; disk widget on dashboard polls API at most every 30s; modal refresh button bypasses both caches |
| `SquadGame.log` for an active server can be 50+ MB; full read explodes bundle | New bridge RPC `file_read_tail({path, max_bytes, since_ts?})` reads only the last N bytes; bundle builder requests at most 64 KB per server |
| Bundle endpoint blows API memory with concurrent requests | Throttle 1/30s per user; Redis cache shared across tabs; builder streams sections as they're rendered, never holds full bundle in memory beyond the cap |
| Wipe destroys evidence during an active incident | Wipe is `host:manage`-only and the action itself is in `audit_log`; UI confirm dialog spells out consequences |
| Sensitive data leaks in bundle | Redaction list applied to every rendered string; `Rcon.cfg` content is structurally excluded (only sha + metadata); golden test asserts no `password=` substring leaks |
| Modal "по серверам" with 100+ servers becomes a wall of text | Sort by saved-bytes desc, paginate at 25 rows; no infinite scroll |

## 7. Testing

- **Unit**: `diag.emit` (Redis-up + Redis-down fallback paths), redaction regex, classification heuristic, dedup logic in §2 builder, file_read_tail bridge RPC.
- **Integration (Tier 2)**: bundle endpoint over Fastify `inject()` with seeded `diagnostic_events` fixture → assert sections present, ordering, redaction applied, truncation report when oversized. Wipe endpoint: post → assert TRUNCATE + audit_log row + diag:queue empty. Disk-usage endpoint: stub bridge response → assert derived percentages.
- **Golden test**: fixed event corpus → expected markdown bundle. Updated by `pnpm test -u` only when human-reviewed; CI fails on diff.
- **E2E (Tier 3)**: `bridge-rpc.e2e.test.ts` adds success+forbidden cases for `panel_disk_usage` and `file_read_tail`. New Playwright spec: open dashboard → click `Диагностика` → select 1h → click `Скачать .md` → assert blob downloaded with content type `text/markdown`, parse first 1 KB and assert structural markers (`# Squad Panel Diagnostic Bundle`, `## 0. State snapshot`).
- **Property test**: `diag.emit` under random concurrent producer load — assert no duplicates, no out-of-order writes within `(component, server_id)`.

## 8. Documentation impact

Following the documentation hard-gate in `CLAUDE.md`, the following docs MUST be created/updated in the same PR(s):

**New component**: `docs/components/diagnostic-bundle/` (full 8-file template — README, api, data-model, flows, configuration, testing, troubleshooting, changelog).

**Updated**:
- `docs/components/bridge/api.md` — new RPCs `panel_disk_usage`, `file_read_tail`
- `docs/components/bridge/changelog.md` — new RPCs entry
- `docs/components/api/api.md` — new routes `GET /diagnostics/bundle`, `POST /diagnostics/wipe`, `GET /host/disk-usage`
- `docs/components/api/data-model.md` — `diagnostic_events` table schema
- `docs/components/api/changelog.md` — entry
- `docs/components/web/api.md` and `flows.md` — new components `<DiagnosticsMenu>`, `<DiskBreakdownModal>`, disk widget extension
- `docs/components/workers/worker-diag-flush/` — new worker, full 8-file template
- `docs/components/workers/worker-event-partition/configuration.md` — additional 24h drop policy for diag partitions
- `docs/architecture/data-flow.md` — diag pipeline (component → diag.emit → Redis Stream → flush worker → Postgres)
- `docs/architecture/decisions.md` — decision record for separate `diagnostic_events` table (vs. extending `audit_log` or external Loki)
- `docs/operations/environment-variables.md` — any new env (e.g. `DIAG_FLUSH_BATCH_SIZE`, `DIAG_BUNDLE_MAX_BYTES`)

## 9. Open questions

None remaining at design time. All scope decisions resolved during the 2026-04-28 brainstorm:
- diagnostic_events is a **separate table** (not extending audit_log)
- retention is **24 hours**, with manual wipe allowed
- Squad-game internals are **excluded** except Warning/Error/Fatal/LogExit on demand
- bundle is **global only**, no per-server variant
- disk widget gets **one extra sub-segment**, not a redesign
- size cap is **400 KB**, designed to fit any current coding-agent context

## 10. Out of scope (explicitly deferred)

- Loki/Grafana log shipping (own design, parent observability epic)
- Multi-host / cluster diagnostics (assume single host for now)
- Long-term cold archive of diagnostic events to S3 (not justified at 1d retention)
- Diagnostic event browsing UI inside the panel (operator gets either the bundle or psql)
- Email/Discord alerts driven by diagnostic events (the panel-observability spec covers alerting)
