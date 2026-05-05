# Epic 5: Squad Server Management — Gap Completion

**Date:** 2026-05-05
**Status:** Approved
**Scope:** All remaining gaps in Epic 5 (server lifecycle, Docker containers, configuration, discovery, health, depot updates). The codebase already implements ~75% of Epic 5; this spec covers the remaining ~25%.

## Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Create wizard steps | 2-step minimal | Settings editor handles post-creation tuning; lean wizard gets to running server fastest |
| Coordinated depot update | Operator picks which servers to stop | Gives control without complexity; avoids killing active matches blindly |
| A2S query location | Inside RCON worker | Single worker handles all server health probing; A2S is stateless UDP, no persistent connection |
| Crash detection response | Log + UI indicator + in-app toast | Immediate visibility without external notification plumbing; Discord webhook is natural P1 follow-on |
| Container metrics retention | Redis stream, 24h | Covers overnight debugging window; no Postgres tables or rollup jobs; matches existing metrics-sampler pattern |

---

## P0 Features

### 1. Server Create Wizard

**Location:** `apps/web/src/app/(dashboard)/servers/new/page.tsx`

**2-step wizard:**

**Step 1 — "Новый сервер":**
- Display name (required, unique slug auto-derived)
- Game port (default 7787)
- Query port (default 27165)
- Beacon port (default 15000)
- RCON port (default 21114)
- Port conflict validation: API checks all ports against existing servers' `server_settings` and rejects duplicates
- Each field shows the default; operator only changes what they need

**Step 2 — "Подтверждение":**
- Review card showing name and all ports
- Note: "Конфигурация будет создана из стандартных файлов Squad. Настройки ресурсов можно изменить после создания."
- Submit → `POST /api/v1/servers` → redirect to `/servers/:id` (existing install WS kicks in)

**No new API endpoints needed.** Existing `POST /api/v1/servers` + `POST /api/v1/servers/:id/install` + install WebSocket handle the backend.

**Navigation:** Dashboard "+" button and "Создать сервер" button in server list empty state.

---

### 2. Server Settings Editor

**New API endpoint:** `PUT /api/v1/servers/:id/settings`
- Permission: `server:edit_settings` (already defined)
- Accepts partial updates to `server_settings` fields
- Audit log entry with before/after snapshots
- Server must be `stopped` or `ready` to change ports
- Resource limits changeable anytime, take effect on next start

**Validation rules:**
- Ports: 1024–65535, no conflicts with other servers, all four must be different
- maxPlayers: 1–100
- tickrate: 10–60
- cpuAffinity: valid CPU mask string or null (disabled)
- memoryHighMb / memoryMaxMb: null (no limit) or 2048+
- niceness: -20 to 19
- ioWeight: 10–1000 or null

**Also:** `PATCH /api/v1/servers/:id` for display name, description, and tags. Lightweight, no restart required.

**UFW sync:** If ports changed, API calls `ufw_rule` to remove old rules and add new ones.

**Web UI:** New "Настройки" tab on server detail page (`/servers/:id/settings`).

Three sections:
1. **Сеть** — port fields (disabled with message when server is running)
2. **Игра** — maxPlayers, tickrate
3. **Ресурсы** — resource limit fields, each with toggle (off = no limit, on = input). Label: "Применяется при следующем запуске"

---

### 3. Force-Stop

**New API endpoint:** `POST /api/v1/servers/:id/force-stop`
- Permission: `server:force_stop` (already defined)
- Calls `container_rm` (immediate kill)
- Does NOT auto-restart — server stays `stopped`
- Audit log: `action: 'server.force_stop'`

**Why `container_rm` not `container_stop -t 0`?** The scenario for force-stop is a hung server where graceful stop already timed out. `container_rm -f` is the reliable kill. The start flow already handles "no container exists" by calling `container_run`.

**Web UI:** Stop button becomes a split-button dropdown:
- Primary: "Остановить" (graceful, existing)
- Dropdown: "Принудительная остановка" → confirmation dialog: "Сервер будет немедленно остановлен без сохранения. Все игроки будут отключены. Продолжить?" → red "Остановить принудительно" button

Visible only with `server:force_stop` permission.

---

### 4. Coordinated Depot Update

**Enhanced `POST /api/v1/depot/update` request body:**
```json
{
  "serverIds": ["uuid-1", "uuid-3"]
}
```

Empty array or omitted = update depot only (no server stop/start).

**Orchestration steps (streamed via existing depot progress WebSocket):**

1. **Validate** — listed servers exist and are stoppable (`running` or `starting`)
2. **Broadcast** — RCON `AdminBroadcast` to each selected server: "Сервер будет остановлен для обновления через 60 секунд"
3. **Wait 60s** — countdown streamed to WebSocket
4. **Graceful stop** — existing stop logic for each server (parallel), stream per-server status
5. **Run SteamCMD** — `depot_update` RPC, stream output
6. **Store build ID** — parse from SteamCMD output, write Redis key `depot:build_id`
7. **Restart** — `container_start` / `container_run` for each stopped server, stream per-server status
8. **Done** — final WebSocket message with summary

**Failure handling:** If SteamCMD fails, servers that were already stopped get restarted on the old version. Never leave servers down due to an update failure.

**`depot_version` tracking:** Redis key `depot:build_id`, read by `GET /api/v1/depot` (add `buildId` field). No Postgres column — build ID is ephemeral metadata about volume state.

**Web UI enhancement:**
- Current build ID displayed on depot page
- "Обновить Squad" button → modal with checkboxes per running server
- Server checkboxes show player counts from RCON status
- Progress view: stopping → updating → restarting phases

---

### 5. A2S Query in RCON Worker

**New module:** `apps/workers/rcon/src/a2s.ts`
- Implements A2S_INFO query: single `0x54` challenge-response UDP packet via `dgram`
- Pure function: `queryA2S(host: string, queryPort: number, timeoutMs: number) → A2SResponse | null`
- No external dependencies

**Integration:**
- RCON worker polls A2S alongside RCON every 30s for running servers
- Result in Redis: `a2s:status:{serverId}` with TTL 90s
- Value: `{ visible: boolean, serverName: string, map: string, players: number, maxPlayers: number, latencyMs: number, queriedAt: string }`
- 2s timeout per query. Three consecutive failures → `{ visible: false, reason: 'timeout' }`

**API changes:**
- `GET /api/v1/servers/:id` and `GET /api/v1/servers` — add `a2s_status` field (from Redis, same pattern as `rcon_status`). Returns `null` when not running.

**Web UI:**
- Server card: green globe (visible) / red globe with tooltip (not visible). Hidden when stopped.
- Server detail: "Steam Browser" row in status section — visibility, latency, server name as Steam sees it.

---

### 6. Crash Detection & Alerts

**Detection — in existing status reconciler (`plugins/status-reconciler.ts`):**
- Track `last_known_restart_count` per server in memory
- When `restart_count` increments: crash detected
- Actions on detection:
  - Audit log: `{ action: 'server.crash_detected', context: { restart_count, oom_killed, exit_code, finished_at } }`
  - Redis pub/sub: `server:events:{serverId}` with type `crash_detected`
  - Redis sorted set: `crashes:{serverId}` (score = timestamp, member = crash details JSON). Trim entries >24h via `ZREMRANGEBYSCORE`.

**Crash loop detection:** 3+ crashes within 5 minutes → status set to `failed`, publish `crash_loop` event. Prevents infinite restart loops. Operator must manually restart after investigating.

**API changes:**
- `GET /api/v1/servers/:id` — add `crash_history` field (last 10 from sorted set)
- `GET /api/v1/servers` — add `crash_loop: boolean` per server

**Web UI:**
- Server card: orange badge with crash count (crashes in last hour). Red pulsing badge for crash loop.
- Server detail: "Стабильность" section with crash timeline (24h). Crash loop: red banner "Сервер в цикле аварий — автоперезапуск отключён. Проверьте логи и запустите вручную."
- Toast: "Сервер {name} аварийно перезапустился" when panel is open.

---

### 7. Container Metrics Time-Series

**Extends `worker-metrics-sampler`:**
- Every 30s: call `container_stats` for each running server via shared bridge client
- Store in Redis stream `container:metrics:{serverId}` with `MAXLEN ~ 2880` (24h)
- Stream entry fields: `cpu_percent`, `mem_bytes`, `mem_percent`, `pids`, `timestamp`

**New API endpoint:** `GET /api/v1/servers/:id/metrics`
- Query params: `since` (ISO, default 1h ago), `until` (default now)
- Returns array: `{ timestamp, cpu_percent, mem_bytes, mem_percent, pids }`
- Cap 1000 points; downsample by skipping entries evenly if range exceeds

**Web UI:** New "Мониторинг" tab on server detail page:
- CPU % line chart (0–100%)
- Memory usage line chart (bytes, human-readable labels)
- Time range selector: 1ч / 6ч / 24ч
- Current values as large numbers above charts

---

## P1 Features

### 8. License Management

**DB change:** New column `server_credentials.license_id` (text, nullable).

**API:** The `PATCH /api/v1/servers/:id` endpoint (same one from Section 2 that handles name/description/tags) also accepts `licenseId` and `licenseKey`. Attaching writes both; detaching nulls both. Audit logged.

**Container launch:** `container_run` passes `?LicenseId=X?LicenseKey=Y` in launch args when present.

**Web UI:** "Лицензия" section on settings page. Two fields (License ID, License Key masked). "Привязать" / "Отвязать" buttons. Label: requires restart.

---

### 9. Server Groups & Tags

**No new tables.** `servers.tags` column (text array) already exists.

**API:** `PATCH /api/v1/servers/:id` includes tags (already planned).

**Web UI:**
- Tag chips on server cards (dashboard + list)
- Tag input on settings page (type + enter, x to remove)
- Tag filter on server list (dropdown multi-select)

---

### 10. Per-Server Game Update

**New endpoint:** `POST /api/v1/servers/:id/update`
- Permission: `server:update` (already defined)
- Validates server is stopped
- Calls `depot_update`, then restarts server
- Progress via WebSocket: `GET /api/v1/servers/:id/update/ws`

**Web UI:** "Обновить игру" button on server detail, visible only when stopped.

---

## P2 Features

### 11. Performance Monitoring

**RCON worker** already captures `tickrate_rt`. Store tickrate in `container:metrics:{serverId}` stream (new field).

**Lag spike detection:** Tickrate below 80% of configured target for 3+ consecutive polls (90s) → publish `performance_degraded` event on `server:events:{serverId}`.

**Web UI:** Tickrate line added to Мониторинг charts. Yellow warning badge on server card when degraded. No external alerting.

---

## Architecture Notes

### Files Modified (Existing)

| File | Change |
|---|---|
| `apps/api/src/routes/servers.ts` | Add `a2s_status`, `crash_history`, `crash_loop` to response; add `PATCH /:id` |
| `apps/api/src/routes/depot.ts` | Enhanced `POST /update` with `serverIds` body, build ID tracking |
| `apps/api/src/plugins/status-reconciler.ts` | Crash detection + crash loop logic |
| `apps/workers/rcon/src/supervisor.ts` | Add A2S polling alongside RCON |
| `apps/workers/metrics-sampler/src/index.ts` | Add per-server container_stats collection |
| `packages/shared-types/src/api.ts` | New Zod schemas for settings update, A2S status, crash history, metrics |
| `packages/shared-config/src/permissions.ts` | No change (permissions already defined) |

### Files Created (New)

| File | Purpose |
|---|---|
| `apps/api/src/routes/server-settings.ts` | `PUT /servers/:id/settings` endpoint |
| `apps/api/src/routes/server-force-stop.ts` | `POST /servers/:id/force-stop` endpoint |
| `apps/api/src/routes/server-metrics.ts` | `GET /servers/:id/metrics` endpoint |
| `apps/workers/rcon/src/a2s.ts` | A2S_INFO UDP query implementation |
| `apps/web/src/app/(dashboard)/servers/new/page.tsx` | Create wizard page |
| `apps/web/src/app/(dashboard)/servers/[id]/settings/page.tsx` | Settings editor page |
| `apps/web/src/app/(dashboard)/servers/[id]/monitoring/page.tsx` | Metrics charts page |
| `apps/web/src/components/ForceStopDialog.tsx` | Force-stop confirmation dialog |
| `apps/web/src/components/DepotUpdateModal.tsx` | Coordinated update modal with server checkboxes |
| `apps/web/src/components/CrashBadge.tsx` | Crash/crash-loop indicator |
| `apps/web/src/components/A2SIndicator.tsx` | Steam visibility indicator |
| `apps/web/src/components/MetricsChart.tsx` | Time-series chart component |

### DB Migrations

| Migration | Change |
|---|---|
| `add-license-id-to-credentials` | Add `license_id` text column to `server_credentials` (P1) |

No other schema changes. All P0 features use existing tables + Redis.

### Redis Keys (New)

| Key Pattern | Type | TTL / Retention |
|---|---|---|
| `a2s:status:{serverId}` | String (JSON) | 90s TTL |
| `depot:build_id` | String | Permanent (overwritten on update) |
| `crashes:{serverId}` | Sorted set | 24h (trimmed by score) |
| `container:metrics:{serverId}` | Stream | ~2880 entries (MAXLEN, 24h at 30s) |

### Testing Requirements

| Feature | Test Tier | File |
|---|---|---|
| A2S parser | Unit | `apps/workers/rcon/test/a2s.test.ts` |
| Settings validation | Unit | `apps/api/test/server-settings.test.ts` |
| Force-stop endpoint | Integration | `apps/api/test/server-force-stop.test.ts` |
| Settings endpoint | Integration | `apps/api/test/server-settings.test.ts` |
| Metrics endpoint | Integration | `apps/api/test/server-metrics.test.ts` |
| Coordinated depot update | Integration | `apps/api/test/depot-update.test.ts` |
| Crash detection | Integration | `apps/api/test/crash-detection.test.ts` |
| Full lifecycle with A2S | E2E | `apps/api/test/e2e/install-lifecycle.e2e.test.ts` (extended) |
| Settings + restart | E2E | `apps/api/test/e2e/install-lifecycle.e2e.test.ts` (extended) |
