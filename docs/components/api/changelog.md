# `api` — changelog

## 2025-11-15

### Added

- `server-install.ts` WebSocket flow that drives `bridge.depot_update` → `seedConfigs` → `bridge.container_run`.
- `plugins/status-reconciler.ts` polling loop (4 s) for Docker→DB status sync.
- `server-configs.ts` Monaco-backed editor with append-only `config_versions` history, blame, and restore-as-new-version.
- `depot.ts` (`GET /depot/status`, `WS /depot/update`).

### Removed

- All routes that called the legacy `bridge.steamcmd_run` / `bridge.systemctl_*` / `bridge.apt_install` surface. The container migration replaced them with the install/depot/container flows above.

### Changed

- `app.makeBridgeClient()` is now used by `server-logs.ts` and `server-install.ts` — the singleton `app.bridge` was starving sibling calls during long streams.

## Panel observability

### Added

- `GET /api/v1/logs` + `GET /api/v1/logs/export` — connector-logs API backed by the `panel:logs` Redis Stream and the [`log-stream-sink`](../shared-config/README.md) pino multistream.
- `GET /api/v1/host/metrics/history` — 24 h history feed sourced from `host:metrics` written by [`worker-metrics-sampler`](../workers/README.md#worker-metrics-sampler).
- `GET /api/v1/host/bridge-status` — bridge ping with round-trip latency for the dashboard.
- `WS /api/v1/depot/progress/ws` and `GET /api/v1/depot` — depot-update progress feed and current-volume report.
- `GET /api/v1/servers/:id/events` — paged tail of `events:server:{id}` for the per-server events page.
- `GET /api/v1/servers/:id/install/progress` — polling-friendly snapshot to complement the install WS.

### Changed

- WebSocket paths gained explicit `/ws` suffix: `/servers/:id/install/ws`, `/servers/:id/logs/ws`, `/depot/progress/ws`. The earlier ad-hoc shapes were removed before any client used them.
- TOTP routes moved under `/api/v1/me/totp/*` (`provision`/`enable`/`disable`).
- The setup flow is now multi-step: `check-env` → `org` → `owner` → `finalize`.

## 2026-04-25

### Added

- [`plugins/bridge-heartbeat.ts`](../../../apps/api/src/plugins/bridge-heartbeat.ts) — 5 s `bridge.ping()` loop with state-transition logging (alive→down emits `warn`, down→alive emits `info` with the down-duration, healthy ticks emit `debug`, consecutive failures emit `debug 'still down'` to avoid warn flapping). Includes `inFlight` overlap guard and a `stopped` sentinel so a late `onReady` can't leak a timer after `onClose`. See [flows.md → Bridge heartbeat](flows.md#bridge-heartbeat).
- Per-RPC bridge logging in [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts) — every dispatcher call emits `rpc <method> start` / `<ms>ms ok` / `<ms>ms err: …` via `onLog`. The api wires `onLog → app.log`, so every bridge RPC lands in `panel:logs` for the connector-logs UI.

### Changed

- `apps/api/src/lib/logger.ts` — `buildLogger` now returns `{ logger, lateSink }` and constructs pino with `multistream([{ stdout|pretty }, { lateSink }])`. `apps/api/src/server.ts` calls `lateSink.setInner(redisSinkStream({ redis: app.redis, defaultSource: 'api' }))` immediately after `redisPlugin` registers, so every API log line shadows into the `panel:logs` Redis Stream alongside stdout/journald. Logs emitted between pino construction and the sink wire-up drop silently to the Redis side (≈ 7 plugin registrations of api logs per boot are stdout-only); intentional.
- `GET /api/v1/logs/export` AUDIT section is capped at 50 000 rows and emits a one-line truncation marker if the cap is hit. Earlier draft fetched all 24 h-eligible rows into memory before the first yield. The squad-game-logs section now races `bridge.container_logs_follow` against a 1500 ms deadline (with `clearTimeout` on the loser) so each per-server tail is a bounded one-shot rather than an open follow.

## 2026-04-25 — Steam profile enrichment

### Added

- `apps/api/src/lib/steam-profile.ts` — `fetchSteamProfile(steamId64, { apiKey, redis, fetch? })` calls `GET /ISteamUser/GetPlayerSummaries/v0002/` and returns `{ persona, avatarUrl } | null`. Results are cached in Redis under `steam-profile:{steamId64}` with a 1 h TTL. Returns `null` for empty API key, HTTP error, empty `players[]`, or tombstone-free cache miss; corrupt cache JSON falls through to a live refetch.

## 2026-04-25 — Session refactor: steamId64 + sliding TTL

### Changed

- `apps/api/src/lib/sessions.ts` — `SessionRecord` now carries `steamId64: bigint` (replaces `userId: string`) and `lastActivityAt: Date`. `createSession` accepts `{ steamId64, ip, userAgent, ttlMs }`. `resolveSession` parses `steamId64` via `BigInt(string)` from the Redis cache. BigInt is JSON-serialised as `String(bigint)` and parsed back on read to keep `JSON.stringify` safe.
- `revokeAllForUser` renamed to `revokeAllForPlayer(db, redis, steamId64: bigint)`.

### Added

- `touchSession(input: TouchSessionInput): Promise<boolean>` — Redis `SETNX session-touch:{id} EX throttleSeconds` gates DB writes. Returns `true` and calls `updateDb(newExpiresAt, now)` on first call within the throttle window; returns `false` (no DB write) on subsequent calls. Enables low-cost sliding session TTL without hammering Postgres on every request.

## 2026-04-25 — First-owner atomic claim

### Added

- `apps/api/src/lib/first-owner.ts` — `claimFirstOwner(db, bridge, steamId64)` performs a dual-anchor atomic first-owner claim. Dual anchor: bridge sentinel file (`/var/lib/squad-panel/.first-owner-claimed`) checked first as a cheap pre-check; `organizations.settings.first_owner_claimed` DB flag checked inside the transaction. `pg_advisory_xact_lock(hashtext('first_owner'))` serialises concurrent OAuth callbacks. Sentinel `fileAtomicWrite` is the last operation in the transaction — bridge failure rolls back all DB state and leaves the trick armed. Returns `'claimed' | 'already_claimed' | 'no_owner_role'`.
