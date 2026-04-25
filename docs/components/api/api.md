# `api` — public surface

Routes are registered in [`apps/api/src/server.ts`](../../../apps/api/src/server.ts) and split across files in [`apps/api/src/routes/`](../../../apps/api/src/routes/). Schemas are Zod via `fastify-type-provider-zod`. Interactive docs at `/api/v1/docs` when `NODE_ENV !== 'production'`.

## Conventions

- **Authentication**: cookie `__Host-sid` (`Secure; HttpOnly; SameSite=lax; Path=/`). Set on `POST /api/v1/auth/login`. Cleared on `POST /api/v1/auth/logout`.
- **Authorisation**: every authed route declares `config.permissions: PermissionKey[]`. Anonymous → 401. Missing permission → 403.
- **Audit**: every mutation must declare `config.audit: { action, resource }`. The CI gate [`audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) fails the build otherwise.
- **bigserial IDs**: `audit_log.id` is serialized as a string to survive `JSON.stringify`.

## Setup (one-shot, 2 steps)

Single-pass wizard: `check-env` → `init`. Once `init` completes, both endpoints return `410 setup_already_complete`.

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/setup/check-env` | Probes bridge (`host_info`) and reports `bridge`, `host`, `public_url`, `steam_web_api` readiness. Returns `{ ok, checks: Record<string, { ok, detail? }> }`. | none |
| POST | `/api/v1/setup/init` | Atomic transaction: insert organisation + seed 4 system roles (`Owner`, `Senior Admin`, `Admin`, `Viewer`) + set `setup_complete=true`. Body: `{ name, slug? }`. Returns `{ org_id, slug }`. | none |

## Authentication and account

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| POST | `/api/v1/auth/login` | Email + password (+ TOTP code or backup code). 5/15min rate limit per IP. Body: `{ email, password, totp_code?, backup_code?, remember_me? }`. | none |
| POST | `/api/v1/auth/logout` | Revoke session, clear cookie. | session |
| GET | `/api/v1/me` | Current user, permissions array, clearance. | session |
| POST | `/api/v1/me/totp/provision` | Generate TOTP secret + 10 backup codes. Returns otpauth URI + plaintext backup codes (shown once). | session |
| POST | `/api/v1/me/totp/enable` | Confirm provisioned secret with a valid 6-digit code. Body: `{ totp_code }`. | session |
| POST | `/api/v1/me/totp/disable` | Re-auth with password and clear TOTP. Body: `{ password }`. | session |
| GET | `/api/v1/auth/steam/login` | Generates a random nonce (base64url, 16 bytes), stores it in Redis (`steam-nonce:{nonce}`, TTL 300 s) and a `__Host-steam-nonce` cookie, then redirects to `steamcommunity.com/openid/login`. | none |
| GET | `/api/v1/auth/steam/callback` | Validates nonce cookie↔query match, single-use Redis nonce, `return_to` host-binding to `PANEL_PUBLIC_URL`, Steam `check_authentication`, and `openid.response_nonce` replay guard (`steam-response-nonce:{nonce}`, TTL 3600 s, NX). On success: upserts `players` row, runs `claimFirstOwner`, checks permissions; redirects to `/` with `__Host-sid` cookie on success or `/no-access?steam_id64=…` when no role is assigned. | none |
| GET | `/api/v1/auth/discord/login` | **Stub (501)** — Discord OAuth lands in Phase 1. | none |
| GET | `/api/v1/auth/discord/callback` | **Stub (501)**. | none |

## RBAC reference

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/permissions` | Full registered permission key set + system role mapping. Used by the role-management UI. | none |

## Servers

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/servers` | List + per-server `rcon_state` / `player_count` / `last_poll_at` from Redis. | `server:view` |
| POST | `/api/v1/servers` | Create row in `pending`. Allocates ports, generates RCON password, encrypts and stores. | `server:create` |
| GET | `/api/v1/servers/:id` | Full detail: settings, RCON status, container inspect+stats, host info. | `server:view` |
| DELETE | `/api/v1/servers/:id` | Best-effort `container_rm` then delete row. Bind-mounted dirs retained. | `server:delete` |
| POST | `/api/v1/servers/:id/start` | If container exists → `container_start`; otherwise `container_run`. | `server:start` |
| POST | `/api/v1/servers/:id/stop` | RCON `AdminBroadcast` → 15s wait → `AdminEndMatch` → `container_stop` (60 s grace). | `server:stop` |
| POST | `/api/v1/servers/:id/restart` | `container_stop` then `container_start`. | `server:restart` |
| GET | `/api/v1/servers/:id/events` | Recent envelopes from `events:server:{id}` (XREVRANGE, default 100). Used by the live-events UI. | `server:view` |

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

## Players

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| GET | `/api/v1/players` | Up to 200 most-recently-seen, ordered by `last_seen_at`. | `player:view` |
| GET | `/api/v1/players/:steamId` | Full detail with name history; IP history is gated by `player:view_ips` (returned as empty array + `ips_visible:false` otherwise). | `player:view` |

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

## Adding a route

1. Register in the relevant file under [`apps/api/src/routes/`](../../../apps/api/src/routes/).
2. Set `config.permissions: ['some:key']` (use [`packages/shared-config/src/permissions.ts`](../../../packages/shared-config/src/permissions.ts) or extend it).
3. If it mutates state (`POST`/`PUT`/`PATCH`/`DELETE`), set `config.audit: { action, resource }`. The CI gate fails the build otherwise.
4. Update this file's table.
