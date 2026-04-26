# `api` — public surface

Routes are registered in [`apps/api/src/server.ts`](../../../apps/api/src/server.ts) and split across files in [`apps/api/src/routes/`](../../../apps/api/src/routes/). Schemas are Zod via `fastify-type-provider-zod`. Interactive docs at `/api/v1/docs` when `NODE_ENV !== 'production'`.

## Conventions

- **Authentication**: cookie `__Host-sid` (`Secure; HttpOnly; SameSite=lax; Path=/`). Set on `GET /api/v1/auth/steam/callback`. Cleared on `POST /api/v1/auth/logout`. As an alternative for programmatic access, requests may carry `Authorization: Bearer sqp_…` (an API token minted via `/api/v1/me/tokens`) — the cookie path takes precedence when both are present. Token-managing routes (`/api/v1/me/tokens*`) reject Bearer auth.
- **Identity anchor**: `players.steam_id64` (bigint). There are no email/password accounts. All sessions and permissions are keyed on Steam ID.
- **Authorisation**: every authed route declares `config.permissions: PermissionKey[]`. Anonymous → 401. Missing permission → 403.
- **Audit**: every mutation must declare `config.audit: { action, resource }`. The CI gate [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) fails the build otherwise.
- **bigserial IDs**: `audit_log.id` is serialized as a string to survive `JSON.stringify`.

## Authentication and account

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/auth/steam/login` | Generates a random nonce (base64url, 16 bytes), stores it in Redis (`steam-nonce:{nonce}`, TTL 300 s) and a `__Host-steam-nonce` cookie, then redirects to `steamcommunity.com/openid/login`. | none |
| GET | `/api/v1/auth/steam/callback` | Validates nonce cookie↔query match, single-use Redis nonce, `return_to` host-binding to `PANEL_PUBLIC_URL`, Steam `check_authentication`, and `openid.response_nonce` replay guard (`steam-response-nonce:{nonce}`, TTL 3600 s, NX). On success: upserts `players` row, runs `claimFirstOwner`, checks permissions; redirects to `/` with `__Host-sid` cookie on success or `/no-access?steam_id64=…` when no role is assigned. | none |
| POST | `/api/v1/auth/logout` | Revoke current session, clear `__Host-sid` cookie. | session |
| GET | `/api/v1/me` | Current player, permissions array, clearance. Returns `{ steam_id64, canonical_name, avatar_url, permissions, clearance }`. | session |
| GET | `/api/v1/me/sessions` | List own active sessions; `current: true` on the request's session. | session |
| DELETE | `/api/v1/me/sessions/:id` | Revoke own session by id. 404 for foreign session. | session |
| DELETE | `/api/v1/me/sessions` | Revoke all own sessions. | session |
| GET | `/api/v1/me/tokens` | List own API tokens (id, name, scopes, created_at, last_used_at, revoked_at). Never returns plaintext or hash. | session |
| POST | `/api/v1/me/tokens` | Mint a new API token. Body: `{ name: string (1..100), scopes: string[] }`. `scopes ⊆ caller.permissions` (422 `invalid_scopes` otherwise). Hard cap of 25 active tokens per user (409 `too_many_active_tokens`). Returns `{ id, name, scopes, created_at, plaintext: 'sqp_<uuid>_<random>' }` — plaintext appears **once**. | session |
| DELETE | `/api/v1/me/tokens/:id` | Soft-revoke own token (sets `revoked_at`). Idempotent — second call returns `{ ok: true, already_revoked: true }`. 404 for foreign token. | session |

Removed surfaces (no longer exist): `POST /api/v1/auth/login`, `POST /api/v1/me/totp/*`, `GET /api/v1/auth/discord/*`, `POST /api/v1/setup/{org,owner,finalize}`, `GET /api/v1/setup/check-env`, `POST /api/v1/setup/init`.

## RBAC reference

### Permissions

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/permissions` | Full registered permission registry from `@squad/shared-config` — array of `{key, category, label, dangerous?, unimplemented?}`. Used by the role-management UI. | `role:view` |

### Roles

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/roles` | List all roles with `permissions[]` and `assigned_users_count`. Sorted `is_system_role DESC, name ASC`. | `role:view` |
| GET | `/api/v1/roles/:id` | Single role detail. 404 if not found. | `role:view` |
| POST | `/api/v1/roles` | Create role. Body: `{name, color, description?, permissions: PermissionKey[]}`. 409 `role_name_taken` on duplicate name. Returns 201 with the new role object. Audit: `role.create`. | `role:create` |
| PUT | `/api/v1/roles/:id` | Update role (name, color, description, permissions). 400 `owner_role_immutable` for the system Owner role. 409 `role_name_taken` on duplicate name. Invalidates permission cache for all role carriers. Audit: `role.update`. | `role:edit` |
| DELETE | `/api/v1/roles/:id` | Delete role. Cascades `players.role_id` to NULL. 400 `owner_role_immutable` for Owner. Invalidates permission cache before deletion. Audit: `role.delete`. | `role:delete` |

### Users

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/users` | Players with a non-NULL `role_id`, joined to `roles`. Sorted `last_seen_at DESC`. Returns `{steam_id64, canonical_name, last_seen_at, role: {id, name, color, is_system_role}, assigned_at, assigned_by}`. `assigned_at`/`assigned_by` are NULL in this iteration. | `user:view` |

## Servers

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers` | List + per-server `rcon_state` / `player_count` / `last_poll_at` from Redis. | `server:view` |
| POST | `/api/v1/servers` | Create row in `pending`. Allocates ports, generates RCON password, encrypts and stores. | `server:create` |
| GET | `/api/v1/servers/:id` | Full detail: settings, RCON status, container inspect+stats, host info. | `server:view` |
| DELETE | `/api/v1/servers/:id` | **Soft-delete + backup orchestrator**. Phase 1 reads every allowed `.cfg` via `bridge.fileRead` and inserts one `config_versions` row per file with `message = 'deletion-backup-marker <iso>'`. If 0 files were read the route returns 500 `delete_failed` and leaves the server alive. Phase 2-4 are best-effort: `container_stop` (30 s) + `container_rm`, `directory_delete` on `configs/{uuid}` and `saved/{uuid}`, `ufw_rule remove` × 4 (game/query/beacon/rcon). Phase 5 sets `servers.deleted_at = now()`, `deleted_by_steam_id64 = <actor>`, `deletion_backup_marker_id = <first-row-id>`. Audit row written by the route (`server.delete`). On success emits a `server.deleted` LiveEvent. Response: `{ ok, backup_marker_id, files_backed_up, files_attempted, container_removed, configs_dir_removed, saved_dir_removed, ufw_rules_removed, errors[] }`. Repeating the call on an already-soft-deleted server returns 404. | `server:delete` |
| POST | `/api/v1/servers/:id/start` | If container exists → `container_start`; otherwise `container_run`. | `server:start` |
| POST | `/api/v1/servers/:id/stop` | Sets `servers.status='stopping'` and emits `server.status` LiveEvent **before** the RCON sequence so the UI updates instantly and a process crash mid-stop leaves a state the reconciler can resolve. Then RCON `AdminBroadcast` → 15 s wait → `AdminEndMatch` → `container_stop` (60 s grace). | `server:stop` |
| POST | `/api/v1/servers/:id/restart` | `container_stop` then `container_start`. | `server:restart` |
| POST | `/api/v1/servers/:id/reconcile` | Forces a single-server reconciliation: calls `container_inspect` once, maps the docker state, updates `servers.status` if it changed, and emits `server.status` LiveEvent. Returns `{ inspected_state, inspected_running, previous_status, new_status, changed }`. 502 `bridge_unavailable` when the bridge throws — the next call can recover. 404 for unknown/soft-deleted servers. Audit `server.reconcile`. Use this when ops sees a server stuck in `starting`/`stopping`/`installing` longer than expected. | `server:view` |
| GET | `/api/v1/servers/:id/events` | Recent envelopes from `events:server:{id}` (XREVRANGE, default 100). Used by the live-events UI. | `server:view` |

## Server archive (soft-deleted servers)

Backed by [`apps/api/src/routes/server-archive.ts`](../../../apps/api/src/routes/server-archive.ts). All `WHERE deleted_at IS NOT NULL` queries — the active-server routes above filter `deleted_at IS NULL` so a soft-deleted server returns 404 from those endpoints.

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers/archive` | List soft-deleted servers ordered `deleted_at DESC`. Returns `{ items: ArchiveServer[], total }`. | `server:view` |
| GET | `/api/v1/servers/archive/:id` | Archive detail: server meta + `serverSettings` snapshot + deduped list of backup `config_versions` rows (latest per filename, `WHERE message LIKE 'deletion-backup-marker%'`). Returns `{ server, settings, backups[] }`. 404 if not soft-deleted. | `server:view` |
| GET | `/api/v1/servers/archive/:id/configs/:filename` | Read content of the most recent backup version of one cfg file. Returns `{ id, filename, content, sha256_hex, created_at, message }`. 404 if no backup row exists. | `config:view` |
| POST | `/api/v1/servers/archive/:id/restore` | Create a NEW server row (UUIDv7) with metadata copied from the archive. Body: `{ slug: ^[a-z0-9-]+$ (1-64), display_name? }`. 409 `slug_in_use` when an active row already owns the slug (partial unique index `servers_slug_active_key`). 404 when the archive is missing. Audit `server.restore`. Emits `server.restored` LiveEvent. Returns 201 `{ id, archive_id, slug, display_name, status:'pending', next_steps[] }`. **Does NOT install or copy configs** — operator must continue with `POST /servers/:id/install`, then `POST /servers/:id/restore-configs`. | `server:install` |
| POST | `/api/v1/servers/:id/restore-configs` | Overlay backup configs from an archive onto a freshly-installed server. Body: `{ from_archive_id: uuid }`. Reads `config_versions` rows with `message LIKE 'deletion-backup-marker%'` for the archive, skips `Rcon.cfg` (preserves the new server's password), `bridge.fileAtomicWrite`s each onto `configs/{newId}/ServerConfig/`, then inserts one fresh `config_versions` row per restored file (`message = "restored from server <archiveId> backup <iso>"`). Audit `server.restore_configs`. 404 if either the new server or the archive is missing. Returns `{ ok, archive_server_id, files_restored, files_skipped[], files_missing[], config_version_ids[], errors[] }`. | `config:edit` |

Example: list archive

```bash
curl -sS -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/archive | jq .
```

Example: restore

```bash
curl -sS -X POST -H "Cookie: __Host-sid=$SID" -H 'content-type: application/json' \
  -d '{"slug":"alpha-restored","display_name":"Alpha (restored)"}' \
  https://panel.local/api/v1/servers/archive/<archiveId>/restore
# → 201 { id: <newId>, archive_id: <archiveId>, ... }
curl -sS -X POST -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/<newId>/install
# wait for /install to finish (status=ready)
curl -sS -X POST -H "Cookie: __Host-sid=$SID" -H 'content-type: application/json' \
  -d '{"from_archive_id":"<archiveId>"}' \
  https://panel.local/api/v1/servers/<newId>/restore-configs
curl -sS -X POST -H "Cookie: __Host-sid=$SID" https://panel.local/api/v1/servers/<newId>/start
```

Errors:

| Code | Where | Meaning |
|---|---|---|
| 404 `not_found` | GET archive, GET detail, GET single config, POST restore, POST restore-configs | Archive id is not soft-deleted, or no matching cfg backup row, or new server not installed yet. |
| 404 `archive_not_found` | POST restore-configs | The `from_archive_id` body field does not point at a soft-deleted server. |
| 409 `slug_in_use` | POST restore | An ACTIVE server (deleted_at IS NULL) already owns this slug; the partial unique index blocks the insert. Pick a different slug. |

## Server install

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/servers/:id/install` | Kicks off the async install pipeline (depot → seedConfigs → ufw → container_run). Returns immediately with `{ status: 'installing', server_id }`. | `server:install` |
| GET | `/api/v1/servers/:id/install/progress` | Polling-friendly snapshot of the in-memory progress buffer (`app.installProgress`). | `server:view` |
| WS | `/api/v1/servers/:id/install/ws` | Live progress: replays the in-memory buffer, then streams `{ts, step, message}` lines until `done`/`error`. | `server:view` |

## Server configs

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers/:id/configs` | List 19 allowed cfg files with `{name, size, sha256, behavior, exists}`. `behavior` is `hot_reload` / `rotation` / `requires_restart`. | `server:view` |
| GET | `/api/v1/servers/:id/configs/:name` | Tip content + sha256 + behavior class. | `server:view` |
| PUT | `/api/v1/servers/:id/configs/:name` | Atomic write + INSERT into `config_versions`. No-op (sha unchanged) short-circuits. Body: `{ content, message? }`. | `server:config:write` |
| GET | `/api/v1/servers/:id/configs/:name/history` | Versions (newest first). Includes `author_email`, `author_ip`, `message`, `sha256`, `size`. Query: `limit` (≤500). | `server:config:history` |
| GET | `/api/v1/servers/:id/configs/:name/versions/:vid` | Full content of a single past version. | `server:config:history` |
| GET | `/api/v1/servers/:id/configs/:name/diff?from=:vid&to=:vid` | Unified-diff patch text between two versions. | `server:config:history` |
| GET | `/api/v1/servers/:id/configs/:name/blame` | Tip content with per-line attribution. Cached in Redis (`config-blame:{tip_id}`, TTL 24 h). | `server:config:history` |
| POST | `/api/v1/servers/:id/configs/:name/restore/:vid` | Creates a NEW version with the old content (never destructive). Body: `{ message? }`. | `server:config:write` |

## Server logs (per-server)

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| WS | `/api/v1/servers/:id/logs/ws` | Live `docker logs -f` via dedicated bridge connection. `?lines=<N≤5000>` for backfill (default 200). 20 s heartbeat frame so proxies don't kill idle sockets. | `server:view` |

## Live event bus (panel-wide)

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| WS | `/api/v1/ws/live` | Push channel for typed `LiveEvent` frames (`server.status`, `server.deleted`, `server.restored`, `rcon.status`, `bridge.connection`, `worker.heartbeat`). Server pings every 10 s; clients must reply `{"type":"pong"}` within 30 s or the socket is closed (code 4000). See [live-bus component](../live-bus/README.md) for wire formats and producer fan-out. | `server:view` |

## Players

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/players` | Up to 200 most-recently-seen, ordered by `last_seen_at`. Optional `?q=` filter: matches `canonical_name_normalized LIKE %q%` or exact `steam_id64::text`. | `player:view` |
| GET | `/api/v1/players/:steamId` | Full detail with name history; IP history is gated by `player:view_ips` (returned as empty array + `ips_visible:false` otherwise). | `player:view` |
| GET | `/api/v1/players/:steamId/role` | Returns current role or `{role: null}`. Single-role model — each player has at most one panel role. | `user:view` |
| PUT | `/api/v1/players/:steamId/role` | Assign or clear a role. Body: `{role_id: uuid \| null}`. 404 `role_not_found` if the role UUID doesn't exist. 409 `cannot_remove_last_owner` when the change would leave zero Owners. Invalidates the player's permission cache. Audit: `player.role.assign`. | `user:manage_roles` |

## Audit

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/audit?page=&page_size=` | Page-paginated list (default 50, max 200). `id` is stringified bigserial. | `audit:view` |

## Host

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/host/info` | `bridge.host_info` snapshot. | `host:view` |
| GET | `/api/v1/host/metrics` | `bridge.host_metrics` (live sample). | `host:metrics` |
| GET | `/api/v1/host/metrics/history?seconds=<≤86400>` | 24 h history from the `host:metrics` Redis Stream populated by [`worker-metrics-sampler`](../workers/README.md#worker-metrics-sampler). Returns `{ts: number[], v: number[][]}` packed for the [`MetricHistoryChart`](../web/README.md#components). | `host:metrics` |
| GET | `/api/v1/host/bridge-status` | Bridge ping with round-trip latency. Always 200 (no permissions); response carries `connected: true|false`. | none |
| POST | `/api/v1/host/restart` | `bridge.host_agent_restart`. Treats post-call EPIPE/ECONNRESET as success because the socket dies during restart. | `host:bridge_control` |

## Depot

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/depot` | Volume populated? + `build_id` parsed from `appmanifest_403240.acf` + `last_update` JSON from Redis. | `server:view` |
| POST | `/api/v1/depot/update` | Kicks off `bridge.depot_update` in the background. Sets `depot:updating` lock; concurrent calls return `{status:'already_in_progress'}`. Streams output to `depot:progress` Redis Stream. | `server:install` |
| WS | `/api/v1/depot/progress/ws` | Replays last 500 entries from `depot:progress` then tails. Multiple tabs can subscribe to the same update. | `server:view` |

## Connector logs (panel-wide)

Aggregated logs from every panel component (api, workers, bridge events, depot/install steps) are streamed to the `panel:logs` Redis Stream via [`packages/shared-config/src/log-stream-sink.ts`](../../../packages/shared-config/src/log-stream-sink.ts) as a pino multistream sink. Encoding/decoding helpers live in [`log-stream.ts`](../../../packages/shared-config/src/log-stream.ts).

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/logs?src=&lvl=&srv=&q=&before=&after=&limit=` | Cursor-paginated read from `panel:logs`. Filters: `src` is comma-separated source codes (`B/R/L/W/D/I/A` for bridge/rcon/log-ingest/worker/depot/install/api), `lvl` minimum level (`debug|info|warn|error`), `srv` server uuid, `q` substring of `msg`, `before`/`after` Redis stream IDs (`<ms>-<seq>`), `limit` (≤2000, default 500). | `host:view` |
| GET | `/api/v1/logs/export` | Streamed `Content-Encoding: gzip` `text/plain` bundle for off-host triage. Sections in order: `BRIDGE`, `RCON server "<name>" (<uuid>)` × N, `LOG-INGEST server "<name>" (<uuid>)` × N, `WORKERS`, `DEPOT / INSTALL`, `API`, `HOST METRICS 24h (CSV)` (`ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15`), `AUDIT (last 24h)` (capped at 50 000 rows; truncation marker emitted if hit), `SQUAD GAME LOGS server "<name>" (<uuid>)` × N (one-shot tail of `bridge.container_logs_follow squad-<uuid>` raced against a 1500 ms deadline). Filename `panel-logs-<iso>.txt.gz`. | `host:metrics` |

## Health and metrics (no auth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness — DB + Redis ping. |
| GET | `/ready` | Readiness — also requires bridge ping success. |
| GET | `/metrics` | Prometheus metrics from `prom-client`. |
| GET | `/api/v1/health/workers` | Per-worker `worker:heartbeat:{name}` aggregate (alive / age_ms / details). |
| GET | `/api/v1/health/reconciler` | Status-reconciler diagnostics — `last_tick_at`, `last_tick_duration_ms`, `last_tick_servers_inspected`, `consecutive_tick_errors`, `stuck_servers[]` (rows in `starting`/`stopping`/`installing` with `updated_at` older than 90 s — `{id, status, updated_at, age_ms}`), `bridge_failures_by_server` (per-id consecutive `container_inspect` failures), and a derived `healthy` boolean (true ⇔ last tick within 12 s, no consecutive errors, no stuck rows). Unauthenticated, no permission gate — same threat model as `/health`. |

## Adding a route

1. Register in the relevant file under [`apps/api/src/routes/`](../../../apps/api/src/routes/).
2. Set `config.permissions: ['some:key']` (use [`packages/shared-config/src/permissions.ts`](../../../packages/shared-config/src/permissions.ts) or extend it).
3. If it mutates state (`POST`/`PUT`/`PATCH`/`DELETE`), set `config.audit: { action, resource }`. The CI gate fails the build otherwise.
4. Update this file's table.
