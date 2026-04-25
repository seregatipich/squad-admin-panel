# `api` — changelog

## 2026-04-25 — API tokens for integrations (P1)

### Added

- `apps/api/src/lib/api-tokens.ts` — `mintApiToken` (`sqp_<uuidv7>_<24-byte base64url>`), `hashApiToken` (sha256 base64url), `looksLikeApiToken`, `extractBearerToken`, `validateScopesSubset`, `intersectScopes`.
- `apps/api/src/routes/me-tokens.ts` — `GET/POST/DELETE /api/v1/me/tokens` (cookie-only). 25 active tokens per user limit. Soft revoke. Audit on POST/DELETE.
- `apps/api/src/plugins/auth.ts` — Bearer authentication path. `req.user.permissions = currentRolePermissions ∩ token.scopes`. `req.apiTokenId` set for audit. `last_used_at` throttled to once per 60 s via Redis SETNX.

### Changed

- `apps/api/src/plugins/audit.ts` — forwards `req.apiTokenId` into `audit_log.actor_token_id` (column was always NULL before).
- `apps/api/src/plugins/types.ts` — `FastifyRequest.apiTokenId?: string`.
- `apps/api/src/server.ts` + `apps/api/test/integration/harness.ts` + `apps/api/test/audit-coverage.test.ts` — register `meTokensRoutes`.

### Tests

- `apps/api/test/api-tokens.test.ts` — 17 unit tests on the lib helpers.
- `apps/api/test/me-tokens.test.ts` — 9 integration tests: list/create/revoke happy + error paths, scope validation (422), idempotent revoke (already_revoked), audit row written.
- `apps/api/test/auth-bearer.test.ts` — 6 integration tests: Bearer authenticates with intersected scopes, revoked → 401, `last_used_at` advances, cookie wins over Bearer, garbage Bearer ignored, Bearer cannot manage tokens.

## 2026-04-25 (Task 16)

### Removed

- `apps/api/src/lib/totp.ts` — TOTP logic (argon-hashed secrets, time-window verify, backup codes). Deleted with no replacement; Steam-only auth has no password-based 2FA surface.
- `apps/api/src/lib/argon.ts` — argon2 password hashing helper. Deleted; no password login remains.
- `apps/api/src/routes/auth-discord.ts` — Discord OAuth stub routes (`GET /auth/discord/login|callback` returning 501). Deleted; Discord integration has no planned timeline.
- `apps/api/test/totp.test.ts`, `apps/api/test/argon.test.ts` — unit tests for the two deleted libs.
- `apps/api/test/integration/auth.test.ts` — email/password login integration tests. Auth coverage now lives in `apps/api/test/auth-steam.test.ts` and `apps/api/test/auth-sessions.test.ts`.

### Changed

- `apps/api/src/server.ts` — removed `discordRoutes` registration; rate-limit `keyGenerator` now uses `String(req.user.steamId64)` instead of `req.user.id`.
- `apps/api/src/lib/blame.ts` — `BlameVersion`/`BlameLine` interfaces: `author_user_id` field replaced by `author_steam_id64: string | null` + `author_label: string | null`.
- `apps/api/src/routes/server-configs.ts` — history/blame/single-version endpoints return `author_steam_id64` instead of `author_user_id`. `writeVersion` accepts `authorSteamId64: bigint | null` and sets `authorLabel: 'system'` when steam ID is null.
- `apps/api/src/routes/server-install.ts` — `seedConfigs` call uses `authorSteamId64: null, authorLabel: 'system'`.
- `apps/api/test/integration/harness.ts` — `BuildAppOptions.seedOwner` shape changed from `{ email, password, displayName? }` to `{ steamId64: bigint; canonicalName?: string }`. Seed inserts into `players` + `playerRoleAssignments` + `organizationMembers`. `loginAsOwner` calls `createSession` directly and calls `invalidatePermissionCache` to prevent cross-test RBAC cache leakage.
- All integration tests under `apps/api/test/integration/` — updated to use `{ steamId64 }` seed options and `loginAsOwner` helper. `userRoleAssignments` → `playerRoleAssignments`, `userId` → `steamId64` throughout.
- `packages/db/drizzle/0008_steam_only_auth.sql` — fixed `config_versions_no_del` trigger to include `WHEN (pg_trigger_depth() = 0)` so cascade deletes from `servers` work (pre-existing bug from 0008 recreating the table without the guard from migration 0004).

### Fixed

- RBAC module-level cache leakage: tests reusing the same `steamId64` across different isolated Postgres schemas could see stale permissions from a prior test. Fixed by calling `invalidatePermissionCache(steamId64)` in `loginAsOwner` and after explicit role swaps in test bodies.
- `DELETE /api/v1/servers/:id` returning 500 due to the `config_versions` append-only trigger firing on cascade deletes from the parent `servers` row.

## 2026-04-25 (Task 15)

### Added

- `GET /api/v1/players/:steamId/roles` — lists all panel roles currently assigned to a player. Permission: `user:manage_roles`.
- `POST /api/v1/players/:steamId/roles` — assigns a role to a player (idempotent, `ON CONFLICT DO NOTHING`). Audit: `player.role.assign`. Permission: `user:manage_roles`.
- `DELETE /api/v1/players/:steamId/roles/:roleId` — revokes a role. Rejects with `409 cannot_remove_last_owner` when the target is the last holder of any Owner role. Audit: `player.role.revoke`. Permission: `user:manage_roles`.
- `packages/shared-config/src/permissions.ts` — added `user:manage_roles` key. Owner inherits it automatically via `PERMISSION_KEYS` spread.
- `apps/api/test/players-roles.test.ts` — 4 integration tests: assign+revoke happy path, last-Owner lockout protection, GET list, RBAC rejection for roleless caller.

## 2026-04-25 (Task 14)

### Changed

- `apps/api/src/lib/audit.ts` — `AuditEntryInput` now takes `actor: AuditActor` (discriminated union `{ kind: 'steam'; steamId64: bigint; tokenId?: string | null } | { kind: 'system'; label: string }`) instead of flat `actorUserId`/`actorKind` fields. `writeAuditEntry` maps the union to `actorKind`, `actorSteamId64`, `actorTokenId`, and `actorSystemLabel` columns.
- `apps/api/src/plugins/audit.ts` — `onResponse` hook builds actor from `req.user.steamId64` (kind `'steam'`) or falls back to `{ kind: 'system', label: 'http-anonymous' }` for unauthenticated requests. `extractTargetId` updated to handle `steam_id64` param for player-scoped routes.
- `apps/api/src/routes/audit.ts` — `GET /api/v1/audit` select projection updated from `actorUserId` to `actorSteamId64` / `actorTokenId` / `actorSystemLabel`. `actor_steam_id64` is serialised as a string in the JSON response (BigInt safety).
- `apps/api/src/routes/server-install.ts` — background install callbacks now pass `actor` union to `writeAuditEntry` instead of the removed `actorUserId` field.
- `apps/api/test/audit-entry.test.ts` — rewritten with 5 tests covering steam-actor, system-actor, steam-actor with token, before/after undefined mapping, and before/after present mapping.

## 2026-04-25 (Task 13)

### Changed

- `apps/api/src/routes/setup.ts` — collapsed from 4-step wizard (`/org`, `/owner`, `/finalize`, `/check-env`) to 2-endpoint surface (`/check-env` + `/init`). `POST /init` atomically inserts the organisation, seeds all 4 system roles, and sets `setup_complete=true` in a single transaction.

### Removed

- `POST /api/v1/setup/org` — merged into `/init`.
- `POST /api/v1/setup/owner` — owner is now the first Steam player to claim the Owner role via `claimFirstOwner`.
- `POST /api/v1/setup/finalize` — `setup_complete` flag is now set atomically in `/init`.

### Added

- `test/setup.test.ts` — 6 integration tests covering both endpoints.

## 2026-04-25

### Added

- `GET /api/v1/auth/steam/login` — real Steam OpenID 2.0 login handler. Generates a 16-byte base64url nonce, stores it in Redis (`steam-nonce:{nonce}`, TTL 300 s) and a `__Host-steam-nonce` cookie, then redirects to `steamcommunity.com/openid/login`.
- `GET /api/v1/auth/steam/callback` — verifies nonce cookie↔query, single-use Redis nonce, `return_to` host-binding, Steam `check_authentication` RPC, and `openid.response_nonce` replay guard. Upserts `players` row, runs `claimFirstOwner`, checks permissions, creates session and sets `__Host-sid` cookie or redirects to `/no-access?steam_id64=…`.
- `PANEL_PUBLIC_URL` config variable — required, full public URL of the panel, used as `openid.return_to` / `openid.realm` base.

### Changed

- `apps/api/src/routes/auth-steam.ts` — replaced 501 stubs with production logic.

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
