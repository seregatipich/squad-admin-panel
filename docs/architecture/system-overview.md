# System overview

## Responsibilities

| Component | Code | Responsibility |
|---|---|---|
| `api` | `apps/api` | HTTP REST + WebSocket. Auth, RBAC, route handlers, audit logging, status reconciliation, install orchestration. |
| `web` | `apps/web` | Next.js 15 + React 19 dashboard. Server components for auth gates, client components for polling. UI is in Russian. |
| `bridge` | `apps/bridge` | Go daemon, only privileged component. 17 whitelisted RPC methods. Composes `docker run` from structured params; never accepts raw flags. |
| `worker-rcon` | `apps/workers/rcon` | Connects to each running server's RCON port (`127.0.0.1:<rcon_port>`), polls `ListPlayers` every 30 s and `ShowServerInfo` every 90 s, publishes `rcon.players_polled` events to Redis. |
| `worker-log-ingest` | `apps/workers/log-ingest` | Tails `docker logs -f squad-{uuid}` via the bridge, regex-parses `SquadGame.log` lines, emits `EventEnvelope` to `events:server:{id}`. |
| `worker-audit-archiver` | `apps/workers/audit-archiver` | Cold-archives `audit_log` rows older than 90 days. |
| `worker-event-partition` | `apps/workers/event-partition` | Monthly partition rotation for the `events` table. |
| `worker-metrics-sampler` | `apps/workers/metrics-sampler` | Polls `bridge.host_metrics` and writes packed samples into the `host:metrics` Redis Stream. Powers the dashboard's 24 h history chart. |
| Other workers | `apps/workers/{automation,backup,config-sync,discord,scheduler,stats}` | Stubs for post-P0 features. Not wired into the install flow. |
| `packages/db` | Drizzle schema + SQL migrations + seed data. |
| `packages/shared-types` | Zod schemas, including the canonical [EventEnvelope](../components/shared-types/data-model.md). |
| `packages/shared-config` | Permission keys, bridge-method allowlist, heartbeat util. |
| `packages/bridge-client` | TS client for the Go bridge over `/run/panel-host-bridge/bridge.sock`. |

## Main user scenarios

### Install a new Squad server

1. Owner/Senior Admin fills the install wizard at `/servers/new`.
2. `POST /api/v1/servers` → row in `servers` (status `pending`).
3. `POST /api/v1/servers/:id/install` opens a WebSocket. The handler:
   - Calls `bridge.depot_update` if the shared `squad-depot` volume is empty (one-time, ~25 min).
   - Calls `seedConfigs` — copies the 19 `.cfg` templates from `/var/lib/docker/volumes/squad-depot/_data/SquadGame/ServerConfig/` to `/var/lib/squad-panel/configs/{uuid}/ServerConfig/`, rewrites `Rcon.cfg` (password) and `Server.cfg` (display name).
   - Inserts one `config_versions` baseline row per file.
   - Adds `ufw` rules for game/query/beacon/RCON ports.
   - Calls `bridge.container_run` with the structured spec; the bridge composes `docker run -d --network host --user 1001:1001 --read-only -v squad-depot:/squad:ro -v .../configs:/squad/SquadGame/ServerConfig:rw -v .../saved:/squad/SquadGame/Saved:rw squad-server:latest`.
4. `plugins/status-reconciler.ts` polls `container_inspect` every 4 s and flips `servers.status` to `running` when the container is up.
5. `worker-rcon` notices the running server, AUTHs, starts polling.

### Edit a config

1. UI loads `/servers/:id/configs`. Three tabs: Editor (Monaco), History (`config_versions`), Blame.
2. Editor `PUT` writes via `bridge.file_atomic_write` AND inserts a row in `config_versions` (append-only — DB trigger rejects `UPDATE`/`DELETE`).
3. No-op writes (sha256 unchanged) short-circuit and don't pollute history.
4. Restore creates a NEW version with the old content; never destructive.
5. Blame walks `config_versions` with Myers diff (`apps/api/src/lib/blame.ts`), cached in Redis under `config-blame:{tip_version_id}` TTL 24h.

### Watch panel-wide health and connector logs

1. The dashboard's `SystemStatus` widget polls `GET /api/v1/host/bridge-status` (latency + connected flag) and `GET /api/v1/health/workers` (per-worker heartbeat). The 24 h metrics tile opens a modal that fetches `GET /api/v1/host/metrics/history?seconds=86400` and lazy-loads a Recharts area chart.
2. Every panel component (api, workers, depot, install steps, bridge connector status) writes to the `panel:logs` Redis Stream via the [`log-stream-sink`](../components/shared-config/README.md) pino multistream. The connector-logs page at `/logs` polls `GET /api/v1/logs` with filters; operators can also `GET /api/v1/logs/export` for a gzipped support bundle.

### Stop / delete / restore a server

1. `POST /:id/stop` issues RCON `AdminBroadcast` → `AdminEndMatch` → `bridge.container_stop`.
2. `DELETE /:id` is **soft-delete + backup**: the orchestrator (`apps/api/src/lib/server-delete.ts`) backs every allowed `.cfg` into `config_versions` (message `'deletion-backup-marker <iso>'`), then best-effort tears down the container, calls `bridge.directory_delete` on `configs/{uuid}` and `saved/{uuid}`, removes the four UFW rules, and finally sets `servers.deleted_at`/`deleted_by_steam_id64`/`deletion_backup_marker_id`. An audit row records the full `DeleteResult`; `app.liveBus.publish('server.deleted', …)` fans out to every connected UI tab. List/detail/start/stop/restart routes filter `WHERE deleted_at IS NULL`, so the deleted id 404s on the active surface.
3. The archive endpoints (`GET /api/v1/servers/archive`, `…/:id`, `…/:id/configs/:filename`) read soft-deleted rows; the panel surfaces them at `/servers/archive`. Operators restore by `POST /api/v1/servers/archive/:id/restore` (creates a new server row with a fresh slug — partial unique index `servers_slug_active_key` blocks slug collisions on active rows), then `POST /api/v1/servers/:newId/install` (default `.cfg` baseline), then `POST /api/v1/servers/:newId/restore-configs` (overlays backup configs except `Rcon.cfg`), then `POST /api/v1/servers/:newId/start`.

## Critical dependencies

- **Docker Engine** on the host (verified at install time by `scripts/install-host-bridge.sh`).
- **PostgreSQL 16+** (compose service `postgres`).
- **Redis 7+** (compose service `redis`).
- **The `panel` system group** must contain every UID that needs to talk to the bridge. The compose API/worker containers join it via `group_add`. Operators iterating with the host CLI add themselves with `usermod -aG panel $USER`.
- **The shared `squad-depot` named Docker volume** populated by `bridge.depot_update`. Seeded once; reused by every server container as `:ro`.
