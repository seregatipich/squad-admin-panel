# `api` — changelog

## 2026-08-04 — Per-server "update game" now streams real progress

### Fixed

- `POST /api/v1/servers/:id/update` (`routes/server-update.ts`) wrote its SteamCMD output to a `server:update:{id}` Redis Stream that nothing ever read — the panel's "Обновить игру" button showed a spinner for the instant the fire-and-forget POST took to return, then silently reverted with zero indication that a multi-minute update was still running in the background. The endpoint now publishes into the same shared `depot:progress` stream `POST /api/v1/depot/update` already used (both ultimately call the same `bridge.depot_update`, guarded by the same `depot:updating` lock — there is only ever one depot update running at a time), so it's watchable through the existing `GET /api/v1/depot/progress/ws`.
- That WS route never carried a completion signal, so even the fleet-wide "Обновить Squad" dashboard flow had the identical silent-progress gap despite the route already existing. New shared helper [`lib/depot-progress.ts`](../../../apps/api/src/lib/depot-progress.ts) (`publishDepotProgressLine`/`publishDepotProgressDone`) writes a terminal `stream:'event'` entry (`{done:true, final:'done'|'error', error?}`) from both routes' background jobs' `finally` blocks. The WS route forwards it, sends a `{backfill_complete:true}` marker between history replay and live tail so a stale/historical `done` (a prior, already-finished run) is never mistaken for the current one, and synthesizes an immediate done frame from `depot:last_update` for a client that connects after the run it triggered has already finished.
- Fixed a latent self-inflicted stall this change would otherwise have activated: the WS route's blocking `XREAD` ran on the shared `app.redis` singleton, which would queue every other route's Redis command behind it for up to 5 s at a time for as long as any tab had the progress view open — invisible until now because nothing actually connected to this route before. It now runs on a per-connection `app.redis.duplicate()`, matching the existing pattern in `plugins/live-bus.ts`.
- New web component `UpdateProgressModal` (mirrors the existing install-wizard's WS-into-`LogConsole` pattern) is wired into both the per-server update button and the fleet dashboard's depot-update flow.
- Also fixed while touching the dashboard's depot-update call site: it posted `{stop_server_ids: serverIds}` to `POST /api/v1/depot/update`, but the route's Zod schema reads `server_ids` — the "select servers to stop first" checkboxes in `DepotUpdateModal` never actually took effect.

## 2026-07-29 — WS routes added to the permission-matrix auth-boundary sweep (#250)

### Added

- `test/security/permission-matrix.test.ts`'s `collectProtectedRoutes()` no longer silently drops `websocket: true` routes before generating test cases. `live.ts`'s and `server-logs.ts`'s route plugins are now registered in the bare route-collection app (a `liveBus.subscribe(...)` stub was added since `live.ts` calls it at plugin registration time), and the `onRoute` hook tags `websocket === true` routes into a new `wsRoutes` set instead of returning early — still excluded from the `.inject()`-based REST sweep, which cannot complete a WebSocket upgrade. A new `permission matrix coverage` canary asserts `wsRoutes` equals exactly the four currently-permissioned websocket routes (`/api/v1/ws/live`, `/api/v1/servers/:id/logs/ws`, `/api/v1/servers/:id/install/ws`, `/api/v1/depot/progress/ws`), each requiring `['server:view']`.
- New `test/security/ws-auth-boundary.test.ts`: connects a real `ws` client, with no session cookie, to all four routes above against the real `buildIntegrationApp()` harness and asserts each upgrade is rejected 401 (via `ws`'s `'unexpected-response'` event) before the socket opens — the actual regression proof that a future route addition or accidental permission removal on a websocket route fails CI instead of relying on manual source review.
- No production code changed: `plugins/auth.ts`'s fail-closed `onRequest` gate already rejected these unauthenticated upgrades correctly; this closes a test-coverage gap (#230), not a behavior bug.

## 2026-07-29 — Fail-open permission default flipped to fail-closed (#246)

### Fixed

- **Security:** `plugins/auth.ts`'s global `onRequest` hook used to return early — no session required — whenever a route declared no `config.permissions`, treating "nobody added permissions" as "public". `GET /api/docs*` (the full OpenAPI schema and Swagger UI) and `GET /api/v1/host/bridge-status` shipped to production unauthenticated this way. Auditing every route/plugin file found three more live instances: `GET /api/v1/health/workers`, `GET /api/v1/health/reconciler`, and the `integrations-balancer.ts`/`integrations-vip.ts` webhook routes.
- The hook is now **fail-closed**: a route requires `req.user` unless it declares the new `config.public: true` (`plugins/types.ts`). `config.permissions` still narrows further as before. `GET /api/v1/host/bridge-status`, `GET /api/v1/health/workers`, and `GET /api/v1/health/reconciler` now require `host:view`, matching the sibling `GET /api/v1/host/info`. `public-banlist.ts`'s `GET /api/v1/public/banlist` gets `config.permissions: ['banlist:read']` declared (a drift correction — the in-handler check already enforced it).
- `config.public: true` is now explicit on every route that was already intentionally anonymous: `GET /health`, `GET /ready`, `GET /metrics`, the signature-gated webhooks (`integrations-balancer.ts`, `integrations-vip.ts`, `discord-interactions.ts`), the public data portals (`public-stats.ts`, `public-clans.ts`, `public-appeals.ts`, `public-media.ts`), the Steam OAuth entry points (`auth-steam.ts`), and `setup.ts`'s `GET /status` probe. `POST /api/v1/setup/complete` is unchanged — its in-handler `if (!req.user)` check already matched the new default.
- `GET /api/docs*` needed no route-level change: `authPlugin` is registered via `fastify-plugin`, so its hook applies at Fastify's root scope to every descendant route regardless of registration order.
- See the "#246: invert the auth hook to fail-closed" entry in [`architecture/decisions.md`](../../architecture/decisions.md) and the "Fail-closed default" section of [`architecture/rbac.md`](../../architecture/rbac.md#enforcement).

## 2026-07-29 — isolated-db fails loudly instead of guessing a Postgres password (#221)

### Fixed

- `test/integration/isolated-db.ts`'s `hostDbUrl()`/`testDbUrl` no longer fall back to the literal password `admin` when `POSTGRES_PASSWORD`, `DATABASE_URL`, and the repo `.env` all fail to resolve one — that silent default masked a genuinely misconfigured environment as a connection that happened to work. The password resolution (`resolveDbPassword()`) and the default URL it feeds (`defaultDbUrl()`) are now lazy functions, evaluated only inside the `process.env.TEST_DATABASE_URL ?? …` short-circuits in `hostDbUrl()` and the `testDbUrl` export, so a run with `TEST_DATABASE_URL` already set never evaluates them and never throws. When none of the three sources resolves a password, they throw an `Error` whose message contains `Postgres password` instead of connecting as `admin`.

## 2026-07-29 — Run-id-scoped test-db sweep (#212)

### Fixed

- `test/integration/global-setup.ts`'s `dropTestDatabases()` no longer sweeps every `sqtest_*`/`sqtmpl_*`/`sqworker_*` database in the cluster — `pg_database`/`DROP DATABASE` are cluster-wide, so that unscoped sweep let one local session's `globalSetup`/teardown destroy a concurrently-running session's still-live template and worker databases. `global-setup.ts` now generates a random `runId` once per invocation (`randomBytes(4).toString('hex')`), threads it to workers via the new `'squadRunId'` Vitest `provide`/`inject` key (mirroring the existing `'squadTemplateDb'` key), and `isolated-db.ts`'s new `useRunId`/`currentRunId` embed it into every constructed database name (`sqtmpl_<runId>_shared_*`, `sqtmpl_<runId>_<pid>_*`, `sqtest_<runId>_*`, `sqworker_<runId>_<pid>_*`). `dropTestDatabases(runId)` is now exported and scopes its `WHERE` clause to `<prefix>_<runId>_%`, so a sweep only ever drops its own run's leftovers.

## 2026-07-27 — DISCORD-5 роль-синк: роль панели → роль Discord (#152)

### Added

- Five routes in the new [`routes/integrations-discord-role-mappings.ts`](../../../apps/api/src/routes/integrations-discord-role-mappings.ts), all gated on the existing catalogue key `integration:manage` (declarative `config.permissions`; `app.requirePermission(...)` does not exist):
  - `GET /api/v1/integrations/discord/role-mappings` → `{ items[], status }`. Each item is `{ id, role_id, role_name, discord_role_id, source, enabled, created_at, updated_at }`; `role_name` comes from an inner join on `roles`. `source` is the constant `panel_role` and is **synthesised, not stored** — leaderboard-driven roles (top-kills, playtime tiers) are a post-STATS-3 extension that will bring their own columns.
  - `POST …/role-mappings` — `{ role_id, discord_role_id, enabled? }` → `201`. `404 role_not_found` for an unknown panel role, `409 role_mapping_exists` when the role is already mapped (unique `role_id`), `400` for a `discord_role_id` that is not a snowflake.
  - `PATCH …/role-mappings/:id` — `{ discord_role_id?, enabled? }`; `404 mapping_not_found`.
  - `DELETE …/role-mappings/:id` → `{ ok: true }`; `404 mapping_not_found`. Deleting a mapping deliberately does **not** revoke the Discord role — once the mapping is gone the panel no longer manages that role, so reconcile leaves every holder alone instead of mass-revoking.
  - `POST …/role-mappings/reconcile` → `{ enqueued: true }` — asks worker-discord for a full drift repair now.
  All four mutations declare `config.audit`, so `plugins/audit.ts` persists `discord.role_mapping.create` / `.update` / `.delete` / `.reconcile` against `discord_role_mapping`.
- [`lib/discord-role-sync.ts`](../../../apps/api/src/lib/discord-role-sync.ts) — `publishDiscordRoleSync(redis, playerId|null, reason, log?)` (`XADD discord:role-sync MAXLEN ~ 10000`) and `readDiscordRoleSyncStatus(redis)`. The publish is deliberately best-effort and never throws: it runs *after* the role transaction commits, so a Redis blip must not turn a successful role change into a 500, and worker-discord's hourly reconcile re-derives everything anyway. There is no outbox table for the same reason.
- `PUT` and `DELETE /api/v1/players/:playerId/role` ([`routes/players.ts`](../../../apps/api/src/routes/players.ts)) publish a per-player sync request after their transaction commits, with `reason` `player.role.assign` / `player.role.unassign`. This is the ≤60 s reaction path.
- The `status` field on the list route is the worker's last role-sync outcome, read from the Redis key `discord:role-sync:status` (`{ state, reason, message, checked_at }`, or `null` when the worker never reported). It exists so a bot missing **Manage Roles** surfaces in the settings UI instead of failing silently; an unreachable Redis or an unparseable value degrades to `null` rather than failing the request.

### Notes

- `GET /api/v1/me` is unchanged — no capability boolean was added. The UI gates by self-hiding on `403`.
- `isUniqueViolation` here walks the `err.cause` chain: drizzle-orm 0.45 wraps the driver error, so the flat `err.code === '23505'` check used in `routes/marks.ts` does not match.
## 2026-07-27 — LEAD-7 сезоны лидербордов (#178)

### Added

- `GET /api/v1/seasons` ([`routes/seasons.ts`](../../../apps/api/src/routes/seasons.ts)): lists named leaderboard seasons behind `panel_access`, optional `?status=upcoming|active|closed`. Returns `{ items: Season[] }`, `Season = { id, name, starts_at, ends_at, status, finalized }`.
- `POST /api/v1/seasons` and `PATCH /api/v1/seasons/:id`: gated on the **`can_edit_roles` capability flag** (Owner short-circuits it in `lib/rbac.ts`), matching the VIP tier catalogue. The flag is *not* exposed by `GET /api/v1/me`, so the UI hides its management surface on a 403 rather than reading a boolean. Errors: `400 invalid_bounds`, `409 active_season_exists`, `409 season_name_taken`, `404 season_not_found`, `422 season_finalized` (a frozen season's window and lifecycle stop moving, so the stored slice keeps describing the season it belongs to). A season cannot be created directly in the `closed` state.
- Both conflicts are SQLSTATE **23505**, so the handler distinguishes "second active season" from "duplicate name" by the violated constraint name. drizzle-orm 0.45.2 wraps driver errors — the thrown error's message is only `Failed query: …`, and the SQLSTATE plus `constraint_name` sit on `err.cause` — so the route walks the cause chain rather than matching on the message.
- New audit actions `season.create` / `season.update`, both carrying before/after snapshots.

### Changed

- `GET /api/v1/leaderboards` no longer fails for `period=season`. `resolvePeriodStart` used to throw when `period_start` was omitted; the route now resolves the **active** season (`400 no_active_season` when there is none), looks up the named season when `period_start` *is* supplied (the archive view), and reports it as a new `season` payload field (`null` for every other period). `period_start` is derived as the season's start day in **UTC**, matching the day convention the aggregator materialises rows under.
- [`plugins/audit.ts`](../../../apps/api/src/plugins/audit.ts) gains an opt-in `req.auditSnapshots = { before?, after?, targetId? }` channel. The declarative `config.audit` hook previously wrote no before/after, so a route needing them had to opt out with `audit: false` — which `test/audit-coverage.test.ts` allows for only three allowlisted URLs. Routes that do not set the field behave exactly as before.
## 2026-07-27 — VIDEO-4 внешняя публикация медиа (#160)

### Added

- `POST /api/v1/media/:id/publications` ([`routes/media-publications.ts`](../../../apps/api/src/routes/media-publications.ts)): queues a stored media file for fan-out. Body `{ destinations: ('youtube'|'telegram')[] }`. Gated on `can_manage_media` (`403 { error: 'forbidden', required: 'can_manage_media' }`). `404 media_not_found` for an unknown/soft-deleted file; `400 not_a_stored_file` for an `external_link` row, which has no bytes of ours to upload; `409 { error: 'already_queued', destinations }` when any requested direction already has a row — **all-or-nothing**, so a caller's retry is never ambiguous. The 409 path pre-checks *and* catches the unique violation, walking the error `cause` chain: drizzle-orm 0.45 wraps SQLSTATE `23505` where a flat `err.code === '23505'` check misses it and would 500 on the race.
- `GET /api/v1/media/:id/publications`: per-destination status for any panel user. A quota-blocked job appears here as `status: 'queued'` with `error: 'quota_exceeded'` and a future `next_attempt_at` — never `failed`.
- `DELETE /api/v1/media/:id/publications/:destination`: removes a publication (`can_manage_media`; `404 publication_not_found`).
- `GET /api/v1/integrations/media-publishing`: `{ youtube_configured, telegram_configured, release_local_file }`. Reports credential **presence only** — no value, not even masked. YouTube counts as configured only with the full OAuth triple; a partially filled app reads as unconfigured, because a two-of-three refresh only produces a confusing auth failure.
- `PATCH /api/v1/integrations/media-publishing`: flips `release_local_file` (`can_manage_media`).
- Config ([`config.ts`](../../../apps/api/src/config.ts)): optional `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. The API never calls either service — it only reports whether the worker could.
- Audit: `media.publish`, `media.publish.delete`, `media.publish.settings.update`, all written by hand (`config: { audit: false }`, matching the rest of the media modules). `apps/api/test/media-publications.test.ts` asserts no publishing secret reaches an audit row.

### Changed

- `worker-media-publisher` added to both compose files, and `api` now shares a persistent `media_data` volume with it at `/var/lib/squad-panel/media` (`MEDIA_STORAGE_DIR`). The two containers have different WORKDIRs, so the previous relative `./media` default resolved to two separate ephemeral directories — the publisher would have found nothing to upload.

## 2026-07-27 — MOD-4 массовые операции модерации (#61)

### Added

- `POST /api/v1/moderation-actions/bulk` ([`routes/moderation-bulk.ts`](../../../apps/api/src/routes/moderation-bulk.ts)): applies one warn/kick/ban to up to 50 players in a single request, enforcing each target through MOD-2's [`lib/moderation-enforce.ts`](../../../apps/api/src/lib/moderation-enforce.ts). Body `{ server_id, action_type, player_ids, reason, ban_length?, confirm_bulk: true }`; `confirm_bulk` must be the literal `true` (server half of the UI's double confirmation) and repeated ids are deduplicated. **The operation is deliberately non-transactional**: each target's ledger row is written immediately after its RCON command is confirmed, a failure is reported in `results[]` and the loop continues, and the response stays `200` — see the "Bulk moderation" section of [`api.md`](./api.md) for the full semantics, the per-target error codes, and the 25 s time budget. RBAC uses the existing catalog keys only (`mod:warn`/`mod:kick`/`mod:ban_temp`/`mod:ban_perm`, themselves gated on the role's Squad `kick`/`ban` permission by `derivePanelPermissions`); no new permission key was introduced. New audit action `moderation.bulk_action` — one row per target reached through RCON (`target_type='player'`) plus a summary row naming every target (`target_type='server'`), all sharing the request's `bulk_group` in `context`. No migration: the grouping lives in `moderation_actions.context`.
- Web: `apps/web/src/components/BulkModerationModal.tsx` (two-step confirmation — a form, then a target list where a ban additionally requires typing the target count back — plus an `applied`/`failed` result screen with per-target reasons) and multi-select in the live-roster table (`servers/[id]/live-players.tsx`), gated on the caller's `mod:*` keys from `GET /api/v1/me`.

## 2026-07-27 — MOD-3 доказательства для действий модерации (#60)

### Added

- `POST /api/v1/players/:playerId/moderation-actions` body gains optional `evidence_media_ids` — up to 10 ids of existing, non-deleted `media_files` rows. Each becomes a `media_links` row with `entity_type='moderation_action'`, `entity_id` = the new action's id, and `linked_by_player_id` = the caller. Duplicates in the array are deduplicated. `moderation_actions` itself gains no column: `media_links` (VIDEO-2, #158) is the canonical evidence store, so this task ships **no migration**.
- The ids are validated **before** the RCON command is sent — an unknown or soft-deleted id returns `400 { error: 'evidence_media_not_found', media_id }` and nothing is enforced, so a bad id can never leave a player banned in-game with no ledger row to revert. More than 10 ids is a `400` from the body schema.
- Every moderation-action read gains `evidence[]` and `evidence_count`. Each item carries `{ id, kind, external_url, original_filename, mime_type, size_bytes, title, linked_by_player_id, linked_at }`. Applies to `GET /api/v1/players/:playerId/moderation-actions` and to the action returned by the `POST` route.
- Evidence for a whole history page is loaded in **one** query (`media_links` ⋈ `media_files`, `inArray` over the page's action ids, `isNull(media_files.deleted_at)`) — the shape of `reports.ts`'s `loadEvidenceForReports`, not a per-action lookup.

### Changed

- A `media_links` row pointing at a soft-deleted `media_files` row is omitted from `evidence[]` but is **not** deleted — detaching stays an explicit operator action through `DELETE /api/v1/media/:id/links` (VIDEO-2, #158), and restoring the file restores its evidence.

Route gating, error codes and audit configuration are unchanged: `panel_access` plus the live-Squad `kick`/`ban` permission on the write path, `config: { audit: false }` on the history read.
## 2026-07-27 — ISSUE-3 связь тикетов с сущностями панели (#156)

All four routes live in the existing [`routes/issues.ts`](../../../apps/api/src/routes/issues.ts) and inherit that module's gate — authentication only, no `config.permissions` — except the player-card endpoint, which is hand-guarded on `panel_access` because every other section of the player card is. Audit rows are written manually with `writeAuditEntry`, as everywhere else in the module.

### Added

- `POST /api/v1/issues/:id/links` — links a ticket to a `player`, `server`, `moderation_action`, or `media_file` (`{ entity_type, entity_id }` body). `201` with the expanded link; `404 issue_not_found`; `422 unknown_entity` (with the offending pairs in `unknown`) when the polymorphic target does not exist; `409 link_exists` on a duplicate `(issue_id, entity_type, entity_id)`. Audit action `issue.link.create` (target type `issue`).
- `DELETE /api/v1/issues/:id/links/:linkId` — `200 { ok: true }`; `404 link_not_found`; `403 { error: 'forbidden', required: 'can_manage_issues' }` when the caller neither created the link nor holds `can_manage_issues`. Audit action `issue.link.delete`.
- `GET /api/v1/players/:playerId/issues` — reverse lookup for the player card: `{ open_count, items }` over the linked tickets that are not `closed`, newest ticket number first, capped at 50. Gated on `panel_access`.
- `POST /api/v1/issues` accepts an optional `links: [{ entity_type, entity_id }]` (max 20, deduplicated) applied inside the route's **existing transaction**, so "create a ticket from a moderation action" lands the ticket and both links (`moderation_action` + `player`) atomically or not at all. An unknown target rejects the whole request with `422 unknown_entity` and creates nothing. The `issue.create` audit row's `after` snapshot carries the links.
- New table `issue_links` backing these routes — see `docs/components/db/changelog.md` (migration 0105).

### Changed

- `GET /api/v1/issues/:id` gains a `links[]` field: `{ id, issue_id, entity_type, entity_id, label, ref, exists, created_by, created_at }`. `label` is the target's human name (player canonical name, server display name, `<action_type> · <YYYY-MM-DD>`, media title or original filename) and `ref` is where a click goes (`/players/:id`, `/servers/:id`, the offender's card for a moderation action, `/api/v1/media/:id/stream`). A target whose row is gone reads back as `exists: false`, `label: "Удалённый объект"`, `ref: null` — `entity_id` carries no foreign key, so that is a normal state. Soft-deleted servers and media files count as gone (both `GET /api/v1/servers/:id` and the media stream route 404 for them), on read and when validating a new link. No `schema.response` was added to the route, so every pre-existing field is untouched.
- `POST /api/v1/issues` and `GET /api/v1/issues/:id` responses are supersets of their previous shapes; the `issue.created`/`issue.updated` live-bus payloads are unchanged (no new event types).
## 2026-07-27 — LEAD-5 серверный стат-дашборд (#176)

### Added

- `GET /api/v1/statistics` ([`routes/statistics.ts`](../../../apps/api/src/routes/statistics.ts)) — the server-wide statistics slice behind `/statistics`. Querystring `{ from?, to?, servers?, format? }`: `from`/`to` are ISO datetimes resolved through AN-1's `resolveWindow` (default 7 days, clamped to `MAX_WINDOW_DAYS = 92`), `servers` is a CSV of server UUIDs (absent or empty means every server; malformed entries are dropped rather than rejected), `format` is `json` (default) or `csv`.
- Response sections `population` (`avg_online`, `peak_online`, `avg_queue`, `by_hour`, `by_weekday`), `matches` (`by_day`, `modes[]`, `maps[]`), `community` (`new_players`, `chat_messages`, `teamkills`) and `moderation` (`punishments`, `avg_admins`, `peak_admins`), plus `days[]` (the dense UTC-day axis) and `servers[]`. Every metric is a `{ by_server[], totals[], kpi{avg,max,total} }` series whose `kpi.total` is exactly the sum of its per-server points, so a stacked bar chart and its KPI cannot disagree. All metric values are numbers; the payload carries no profiling fields.
- Reads come from the materialised `server_daily_stats` (see `docs/components/db/changelog.md`, migration 0101) — no live scan of `events`/`combat_events`. Hour-of-day buckets are the sole live computation: one windowed pass over `player_sessions`, not AN-1's per-tick correlated subquery. Weekday buckets are a regrouping of the daily rows.
- `format=csv` emits RFC-4180 long format `section,metric,server_id,key,value` with `text/csv; charset=utf-8` and `attachment; filename="statistics.csv"`.
- Gate: the file-local `panelGuard` copied from `analytics.ts` — `401 { error: 'unauthenticated' }` without a session, `403 { error: 'forbidden' }` without the `panel_access` role capability. Read-only, so `config: { audit: false }` and no `audit-coverage` entry. No `schema.response` is declared (that would enable Zod serialization and strip undeclared fields), matching every other analytics route.
- Measured on a seeded window of 180 rollup rows and 36 000 sessions, 30 days × 6 servers responds in **137 ms median** (min 137 / max 142 over five samples after one warm-up) — inside the 500 ms acceptance criterion.

## 2026-07-27 — MOD-2 действия модерации (#59)

### Added

- The five `mod:*` permission keys (`mod:kick`, `mod:warn`, `mod:ban_temp`, `mod:ban_perm`, `mod:unban`) lose `unimplemented: true` in `@squad/shared-config`'s `PERMISSIONS`. `derivePanelPermissions` ([`lib/rbac.ts`](../../../apps/api/src/lib/rbac.ts)) gains a seventh `squadPermissions` parameter and two gates — `mod:kick`/`mod:warn` require the role's live-Squad `kick` permission, `mod:ban_temp`/`mod:ban_perm`/`mod:unban` require `ban` — closing the gap where every `panel_access` user previously received all five keys regardless of their Squad permissions.
- `POST /api/v1/players/:playerId/moderation-actions` (`routes/moderation-actions.ts`): enforces a warn/kick/ban through the new [`lib/moderation-enforce.ts`](../../../apps/api/src/lib/moderation-enforce.ts) helper (RCON via worker-rcon, then the `moderation_actions` ledger row and EVT-1 publish, only once the command is confirmed applied). Body `{ server_id, action_type, reason, ban_length?, source? }`; guarded the same way as `external-bans.ts`'s local-ban route (squad `kick` for warn/kick, `ban` for ban). Audit action `moderation.action` (target type `player`).
- `POST /api/v1/moderation-actions/:id/revert`: unbans a player — removes their `Banned:` line(s) from the panel's `Bans.cfg` copy via the new pure [`lib/bans-cfg.ts`](../../../apps/api/src/lib/bans-cfg.ts) (`removeBanLines`, read-verify-write retried up to 3 times against a racing edit before `409 bans_cfg_conflict`), marks every active ban row for that player+server reverted, and inserts an `unban` ledger row. Audit action `moderation.revert` (target type `player`).
- `GET /api/v1/players/:playerId/moderation-actions` querystring gains `action_type`, `server_id`, and `cursor` filters alongside the existing `limit`; the response shape is unchanged.

## 2026-07-27 — VIDEO-3 делегированная загрузка по одноразовому токену (#159)

### Added

- `POST /api/v1/media/upload-tokens` ([`routes/media-upload-tokens.ts`](../../../apps/api/src/routes/media-upload-tokens.ts)) — hand-guarded on `panel_access`, mints a one-time upload credential. Body `{ target_entity_type?, target_entity_id?, expires_in_seconds? (60…604800, default 7200), max_size_bytes? }`; the target pair must be supplied together or not at all (`400 invalid_target`) and must exist (`404 entity_not_found`). `max_size_bytes` is a request, not a grant: the route clamps it to `MEDIA_MAX_UPLOAD_BYTES`, so a token can never exceed the server-wide cap. `201` returns `{ id, token, upload_url, expires_at, max_size_bytes, target_entity_type, target_entity_id }` — **the raw token appears here once and nowhere else**. Audit action `media.upload_token.mint` (`targetType: 'media_upload_token'`) deliberately records only the token id.
- `POST /api/v1/public/media?token=` ([`routes/public-media.ts`](../../../apps/api/src/routes/public-media.ts)) — public, session-less redemption registered next to `publicStatsRoutes`/`publicClansRoutes`. Accepts one multipart file through the VIDEO-1 `storeMediaUpload` machinery under the token's own `maxBytes`, inserts `media_files` with `uploader_player_id = NULL` and `upload_token_id` set, and — when the token was pre-bound — inserts the matching `media_links` row attributed to the minter. `201 { ok: true, media_id }` is deliberately minimal. Errors: `410 token_used_or_expired` (unknown **or** spent **or** expired — the same body for all three, so the endpoint cannot be used to probe which tokens exist), `413 file_too_large`, `400 magic_byte_mismatch`, `415 unsupported_media_type`, `429 rate_limited`. Audit action `media.public_upload` with a `system` actor labelled `public-upload`, context `{ token_id, ip }`, never the raw token.
- Single use is enforced by the **database**, not application logic: [`lib/media-upload-tokens.ts`](../../../apps/api/src/lib/media-upload-tokens.ts)'s `redeemUploadToken` runs `UPDATE … SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`, so of two concurrent uploads racing the same token exactly one can observe a returned row. The burn happens **after** the bytes are safely on disk, so an aborted or rejected upload leaves the link usable; when the claim loses the race the just-written file is removed and the caller gets `410`.
- Per-IP throttling on the public route is a manual Redis `INCR`/`EXPIRE` (the `leaderboards.ts` pattern, 10/hour, constants exported for tests) rather than the declarative `@fastify/rate-limit` config, because that plugin is not registered in `apps/api/test/integration/harness.ts` and a declarative limit would therefore be untestable.
- New `LiveEvent` variant `media.uploaded` (`{ player_id, media_id, token_id, target_entity_type, target_entity_id }`). [`routes/live.ts`](../../../apps/api/src/routes/live.ts) delivers it only to the socket whose `connectionPlayerId` matches `player_id`, so nobody but the minting admin learns that an anonymous upload happened.

### Changed

- `serializeMediaFile` and the `mediaFileResponse` Zod schema gain `upload_token_id: string | null` — non-null marks evidence that arrived through a one-time link (such a row always has `uploader_player_id = NULL`). Additive and nullable, so every pre-#159 caller parses unchanged.
- `entityExists` in [`routes/media-links.ts`](../../../apps/api/src/routes/media-links.ts) is exported so the mint route can validate a pre-bound target through the same code path as `POST /api/v1/media/:id/links`.
- New table `media_upload_tokens` and column `media_files.upload_token_id` — see `docs/components/db/changelog.md` (migration 0096).

## 2026-07-27 — VIDEO-2 привязка медиа к сущностям (#158)

### Added

- `POST /api/v1/media/:id/links` — attaches a `media_files` row to a `player`, `moderation_action`, `match`, or `issue` (`entity_type`/`entity_id` body, Zod-validated). `201` with the created link; `404 media_not_found`/`404 entity_not_found` when the media file or the polymorphic target doesn't exist; `409 already_linked` on a duplicate `(media_id, entity_type, entity_id)`.
- `DELETE /api/v1/media/:id/links?entity_type=&entity_id=` — detaches a link. `200 { ok: true }`; `404 link_not_found`; `403 { error: 'forbidden', required: 'can_manage_media' }` when the caller neither created the link nor holds `can_manage_media`.
- `GET /api/v1/players/:playerId/media` — evidence for a player card: the union of direct `entity_type='player'` links and `entity_type='moderation_action'` links whose action belongs to the player. Works for EOS-only players (no `steam_id64`) via `players.id`.
- `GET /api/v1/moderation-actions/:id/media` — evidence attached directly to one moderation action.
- All four routes carry `config: { audit: false }` with audit rows written manually via `writeAuditEntry`: `media.link.attach` and `media.link.detach`, both `targetType: 'media_link'`.
- New table `media_links` backing these routes — see `docs/components/db/changelog.md` (migration 0095).

## 2026-07-26 — PLAYER-6 player list sorting and filters (#27)

### Changed

- `GET /api/v1/players` querystring gains `sort` (`nickname` | `last_seen` | `created` | `total_time`, default `last_seen`), `dir` (`asc` | `desc`, default `desc`), and `filter` (`new`). Unrecognised values are rejected with 400 by the Zod `querystring` schema instead of being ignored — `?sort=nickname&dir=asc` sorts, `?sort=bogus` is a 400.
- The route now applies the chosen key as a real SQL `ORDER BY` — `canonical_name_normalized`, `last_seen_at`, `first_seen_at`, or `total_time_played_seconds` — with `players.id` ascending as the stable tiebreak so equal sort values come back in a deterministic order. With no params the ordering is byte-for-byte today's `ORDER BY last_seen_at DESC`, `LIMIT 200`.
- `filter=new` adds `first_seen_at >= now() - interval '7 days'` (evaluated by the database clock) and is `AND`-composed with the existing `?q=` predicate rather than replacing it.
- The response body is unchanged: `{ items: [...], total }` with the same seven item fields, no `schema.response`, `total` still `rows.length` capped by the 200-row `LIMIT`. `GET /api/v1/players/search` is untouched. An active-bans filter stays out of the `filter` enum and is tracked in #59.
## 2026-07-26 — MSG-2 direct player message (#185)

### Added

- `POST /api/v1/servers/:id/players/:playerId/message` in `server-messaging.ts`: one addressed in-game message delivered as RCON `AdminWarn <target> <message>` through the existing worker-rcon command queue. Target resolution prefers `players.eos_id` and falls back to `players.steam_id64`; a row with neither 404s as `player_not_addressable`. Gated on the Squad `chat` permission.
- Body `{ message, log_to_card? }` with `message` capped at 300 characters after trim (minimum 2) — the worker's `BROADCAST_MAX_CHARS`, re-asserted when `AdminWarn` is built. `log_to_card: true` writes one `chat_messages` row keyed on the **addressee** (`scope: 'direct'`, `source: 'panel'`), making the message visible in the target's card chat history with no read-path change; a not-connected worker 502s and writes nothing.
- Audit action `server.player_message` (target type `server`), carrying `player_id`, `target`, `message` and `log_to_card` in `after_snapshot`. No migration — `chat_messages` already accepted the `direct` scope.

## 2026-07-25 — WL-3 whitelist application portal

### Added

- `whitelist-applications.ts` route: public portal (`GET /api/v1/public/whitelist/settings`, `POST /api/v1/public/whitelist/applications` — unauthenticated, rate limited, one pending application per SteamID64) and panel approval workflow (`GET`/`PUT /api/v1/whitelist/applications/settings`, `GET /api/v1/whitelist/applications`, `PATCH /api/v1/whitelist/applications/:id`), gated on `whitelist:view`/`whitelist:edit`.
- Approving a pending application grants the resolved role to the applicant time-bounded via `players.role_expires_at` and fans the change out to every active server's `Admins.cfg`; auto-expiry reuses the existing `worker-role-expirer` (VIPSUB-1) — no new expiry mechanic. New audit actions `whitelist.application.create` / `.review` / `.settings.update`.

## 2026-07-25 — Server-delete Admins.cfg sync-queue cleanup (SYNC-5, #38)

### Changed

- `softDeleteServer` ([`lib/server-delete.ts`](../../../apps/api/src/lib/server-delete.ts)) gained an optional `redis` on `DeleteContext` and a new **Phase 6** that runs after the soft-delete UPDATE: it stamps every still-pending `admins_cfg_sync_outbox` row for the server `relayed_at` (reported as `sync_outbox_cancelled`), then `XGROUP DESTROY` + `UNLINK` (falling back to `DEL`) the `events:admins-cfg-sync:<id>` stream and `DEL`s the `admins-cfg:status:<id>` key. Every step is best-effort — a Redis fault is recorded on `result.errors` under `phase: 'sync_queue_cleanup'` and never aborts the delete; the server row is already marked deleted. `DeleteResult` gains `sync_queue_removed` and `sync_outbox_cancelled`. Prior to this, a soft-deleted server left an orphan Redis stream, its `config-sync` consumer group, and a stale status key behind (the queue was never explicitly cleaned — only bounded by `MAXLEN ~ 500`).
- `DELETE /api/v1/servers/:id` ([`routes/servers.ts`](../../../apps/api/src/routes/servers.ts)) now passes `redis: app.redis` into the delete context so the cleanup runs in production; the field stays optional so archival/unit callers compile unchanged.
- The stream-prefix and consumer-group names are imported from [`lib/admins-cfg-sync.ts`](../../../apps/api/src/lib/admins-cfg-sync.ts) rather than re-declared.

## 2026-07-09 — Parallel API test suite

### Changed

- Isolated test databases are now cloned from a single migrated template (`CREATE DATABASE … TEMPLATE`, ~80ms) instead of replaying all 42 migrations per test (~2.6s of DDL). `global-setup.ts` builds the template once and shares it with workers via Vitest `inject`; the low-level provisioning lives in `test/integration/isolated-db.ts` (deliberately free of route imports so it never pollutes the module registry ahead of a test's `vi.mock`).
- File parallelism is enabled (`pool: 'forks'`, `maxForks: 4`). Each worker gets its own cloned database and a dedicated Redis logical DB via `worker-setup.ts`, so parallel workers never share mutable Postgres or Redis state; tests within a file stay sequential. A `globalSetup` sweeps orphaned `sqtest_*`/`sqtmpl_*`/`sqworker_*` databases.
- Net effect: the full API suite drops from ~1271s to ~142s (~9×) with identical test behavior and isolation guarantees.

## 2026-07-07 — RCON worker command queue

### Changed

- `POST /api/v1/servers/:id/stop` sends `AdminBroadcast` and `AdminEndMatch` through `worker-rcon` when `rcon:status:{serverId}.state = "connected"`. Direct one-shot TCP RCON remains a fallback only when the command was not accepted into the worker stream.
- `PUT /api/v1/servers/:id/configs/:name` uses the same worker-first path for `AdminReloadServerConfig`; the reload outcome can now report `via: "worker-rcon"` and `request_id`.
- RCON stop diag payloads now include `via` and optional `requestId`, so ops can tell whether a command went through the worker queue or direct fallback.

## 2026-07-05 — PNOTE-2 global notes feed

### Added

- `GET /api/v1/notes` — cross-player audit feed of every admin note, newest-first, keyset-paginated (`cursor`, `limit`≤100). Gated by `panel_access` (auth required, no audit rows). Filters combine: `q` (body ILIKE, trigram-indexed), `player` (target nickname ILIKE across the current canonical name **and** `player_name_history`), `author` (author player id), `dateFrom`/`dateTo` (created-at range). `includeDeleted=true` is honored **only** for `can_edit_roles` viewers; for everyone else soft-deleted notes are filtered out in SQL (never serialized). Response carries `can_view_deleted` so the UI can gate the toggle. Each item exposes `target`, `author` (with `role_color`/`role_name`), `edited`, `deleted`, and `deleted_by`.
- `GET /api/v1/notes/authors` — distinct note authors that hold a role, for the feed's author-filter select.
- `GET /api/v1/notes/export?format=csv` — CSV of the current filtered selection (same filter + deleted-visibility rules as the list), `text/csv` attachment capped at 10k rows.
- Indexes on `player_notes`: `player_notes_created_at_idx (created_at DESC, id DESC)` for the global keyset scan, `player_notes_author_id_idx`, and a `gin_trgm_ops` index `player_notes_body_trgm_idx` for body search. No new columns — the soft-delete `deleted_at`/`deleted_by` columns from PNOTE-1 are reused.

## 2026-07-05 — AN-1 dashboard analytics

### Added

- `GET /api/v1/analytics/dashboard` — read-only analytics aggregates gated by `panel_access` (auth required, no permission gate; no audit rows). Query params: `server_id`, `from`, `to` (ISO 8601, default last 7 days, clamped to 92 days), `limit` (popular maps/layers cap), `format=json|csv`. Computes peak concurrent players by hour-of-day (sampled at hourly ticks from `player_sessions`, UTC), match-outcome distribution + popular maps/layers (from `matches`), and an online-hours / unique-players summary (from `player_daily_presence`). Per-server breakdown via `server_id`. `format=csv` returns a `section,key,value` long-format attachment.

## 2026-04-28

### Documentation

- `flows.md` gained a dedicated **Config edit (`PUT /api/v1/servers/:id/configs/:name`)** section: full step ordering (sha-match short-circuit → atomic disk write → `config_versions` INSERT → best-effort RCON `AdminReloadServerConfig`), the bind-mount + `rename(2)` instantaneity guarantee, the three behavior classes (`hot_reload`, `rotation`, `requires_restart`) and what each does after the file lands on disk, and per-step failure modes (orphan-on-disk after a DB blip is benign and self-heals on the next save).
- `api.md` config-route table: corrected permission keys to match `apps/api/src/routes/server-configs.ts` (`config:edit` for write, `config:view` for history/diff/blame/versions, `config:rollback` for restore — the previous `server:config:write` / `server:config:history` keys did not exist in the registry). PUT row now also notes the bind-mount instantaneity, RCON reload outcome shape, and audit-content semantics (sha-only).

## 2026-05-02 — Эпик 2 Phase 2 follow-up: spec compliance round 2

### Added

- Explicit `DELETE /api/v1/players/:steamId/role` endpoint (audit `player.role.unassign`). The legacy `PUT { role_id: null }` is preserved for back-compat.
- `GET /api/v1/users` accepts `q` (nickname/SteamID search) and `role_id` (filter) querystring params.
- Owner is excluded from the player-card role dropdown and the /users assign modal client-side. Backend continues to reject Owner via `owner_assignment_forbidden` 403.
- The /users page now renders a "Снять" button per row (gated by `user:manage_roles`).
- Player card role widget renders for **all** viewers (read-only when no `user:manage_roles`), instead of being hidden entirely.

### Changed

- All admins-cfg-sync publishes now run **inside** the same DB transaction as the role/player mutation. Per spec §2.7.1: a Redis publish failure aborts the DB transaction so role state and stream state stay aligned. Affected handlers: `POST/PUT/DELETE /api/v1/roles`, `PUT/DELETE /api/v1/players/:steamId/role`, `POST/DELETE /api/v1/roles/:id/members[/:steamId]`.
- `POST /api/v1/servers/:id/install` enqueues an initial sync event after install completes (spec §2.7.7 — fresh server gets its `Admins.cfg` written before Squad first boots).
- The structural type `AdminsCfgSyncDb = Pick<DatabaseClient, 'select'>` lets the publish helper accept either a top-level client or a transaction handle.

## 2026-05-01 — Эпик 2 Phase 2: roles + access flags + admins-cfg sync trigger

### Added

- `apps/api/src/routes/role-members.ts` — `GET /api/v1/roles/:id/members` (paginated, search-by-nickname/SteamID), `POST /api/v1/roles/:id/members` to assign, `DELETE /api/v1/roles/:id/members/:steamId` to unassign. Required permissions: `user:view` for read, `user:manage_roles` for mutations.
- `apps/api/src/routes/admins-cfg.ts` — `GET /api/v1/admins-cfg/drift?server_id=<uuid>`, `GET /api/v1/admins-cfg/drift/all` (for ops dashboards), `POST /api/v1/admins-cfg/sync?server_id=<uuid>` (force-sync, audit-logged as `admins_cfg.force_sync`). Required: `admin_group:view` / `admin_group:edit`.
- `apps/api/src/lib/admins-cfg-sync.ts` — `publishAdminsCfgSyncForAllServers` / `publishAdminsCfgSyncForServer` helpers. Used by every role / player-role mutation handler to enqueue events into `events:admins-cfg-sync:<server_id>` for the `worker-config-sync` consumer group.
- `POST /api/v1/roles` and `PUT /api/v1/roles/:id` accept new fields: `squad_permissions: string[]` (validated against the 21-key catalogue), `panel_access: boolean`, `can_assign_roles: boolean`, `can_edit_roles: boolean`. Flag-dependency check returns 400 `panel_access_required_for_role_management` if `panel_access=false` is paired with one of the role-management flags.
- `GET /api/v1/roles` response now includes `panel_access`, `can_assign_roles`, `can_edit_roles`, `squad_permissions` per row.
- `PUT /api/v1/players/:steam_id64/role` rejects assigning the system Owner role with 403 `owner_assignment_forbidden`. The first-login Owner trick path remains intact and is the only way to grant Owner.

### Changed

- `apps/api/src/lib/rbac.ts` rewritten: derived permissions from access flags + union with explicit `role_permissions` grants. Owner hardcoded super-set (all panel keys + all 21 squad perms + all 3 flags). Cache shape extended with `panelAccess`, `canAssignRoles`, `canEditRoles`, `isOwner`, `roleName`, `squadPermissions` — backwards-compatible (existing `permissions: Set<...>` and `roleId` fields preserved).
- `apps/api/src/routes/auth-steam.ts` callback now redirects to `/no-access` when `panelAccess === false` instead of the previous `permissions.size === 0` check.
- Role and player-role mutations enqueue admins-cfg-sync events into Redis Streams in the same response cycle.
- Role delete sweeps all permission caches (`invalidateAllPermissionCaches`) because we don't know which sessions still hold a now-NULL role.

## 2026-04-26 — Reconciler restart-resilience: parallel tick, watchdog, eager start/restart
## 2026-04-29 — Status-flip diag-emit CI gate

### Added

- [`apps/api/test/audit-coverage.test.ts`](../../../apps/api/test/audit-coverage.test.ts) (Phase A2 Task 16) gains a third assertion: for the closed set of routes that flip `servers.status` (`POST /api/v1/servers/:id/start`, `POST /api/v1/servers/:id/stop`, `POST /api/v1/servers/:id/install`, `DELETE /api/v1/servers/:id`, `POST /api/v1/servers/archive/:id/restore`) the test reads the matching handler source file and asserts it still contains a `diag.emit({ ... kind: 'server.<...>' ... })` literal. The check is a regex-based static scan — no live infra needed — and treats `req.diag.emit` / `app.diag.emit` / `installDiag.emit` callsites as equivalent. The test also verifies that every route in the closed set is actually registered (catches drift if a URL is renamed without updating the gate). Failure message names the route AND the handler file so a regression points the developer at the right `.ts`. Today the test passes because Tasks 7 and the soft-delete/restore epic already wired all five emits — its value is regression prevention.
- The new assertion was smoke-tested against the failure path by temporarily renaming every `kind: 'server.*'` literal in `server-install.ts` to `kind: 'svr_renamed.*'`; the test failed with `route POST /api/v1/servers/:id/install flips server.status but does not emit a server.* diag event in .../server-install.ts` as expected, and was reverted before commit.

### Changed

- _None._

### Fixed

- _None._

### Removed

- _None._

### Migration notes

No schema, no env, no public API change. Pure CI guard. If a future change moves the install / start / stop / soft-delete / restore handlers to a new file, update the `STATUS_FLIPPING_ROUTES` map in `audit-coverage.test.ts` accordingly.

## 2026-04-29 — HTTP error layer diag emits

### Added

- `apps/api/src/plugins/error-diag.ts` (Phase A2 Task 15) — new Fastify plugin that registers a `setErrorHandler` and a `process.on('unhandledRejection', ...)` listener. Two new diag kinds enter `diag:queue`:
  - `http.5xx` (severity `error`) — emitted for any thrown response with `reply.statusCode || err.statusCode || 500 >= 500`. Payload `{ method, url, status, err, stack }`; `stack` truncated to 2000 chars. Threads `requestId = req.id` and (when authenticated) `actorSteamId64 = req.user.steamId64.toString()`.
  - `http.unhandled_rejection` (severity `fatal`) — emitted from a process-level `unhandledRejection` listener. Payload `{ reason }`; `reason` and `message` are truncated to 2000 / 200 chars respectively. The listener is attached exactly once per Node process via a module-level guard so a second `errorDiagPlugin` registration (e.g. inside the integration harness) does not duplicate the global handler.
- The error handler preserves Fastify's default reply by calling `reply.send(err)` AFTER the diag emit, so the `{ statusCode, error, message }` JSON envelope clients depend on is unchanged. 4xx errors (auth/rbac/validation/not-found) are intentionally NOT emitted as `http.5xx` — the kind targets true server-side faults only.
- `apps/api/test/diag-http-errors.test.ts` — 4 vitest cases: a synthetic throwing route emits `http.5xx` with the expected payload shape and `requestId`; 4xx responses (403 / 404) do NOT emit `http.5xx`; `stack` is truncated to exactly 2000 chars when the thrown error has a 5000-char stack; the Fastify default JSON envelope is preserved on 5xx (`{ statusCode, error, message }`). The `http.unhandled_rejection` path is covered by code review only — Node's global rejection listener is shared mutable state that cannot be exercised cleanly inside a vitest worker without leaking to sibling tests.

### Changed

- `apps/api/src/server.ts` — registers `errorDiagPlugin` immediately after `diagPlugin` so `app.diag` is decorated when the error handler binds. Plugin registration order becomes `redis → diag → error-diag → db-health → heartbeat-watch → ...`.
- `apps/api/test/integration/harness.ts` — registers `errorDiagPlugin` after `diagPlugin` so integration tests covering 5xx code paths surface the new emits.

### Migration notes

No DB schema changes. No new env vars. Consumers reading `diagnostic_events` will start seeing rows where `component='api'` and `kind` matches `http.5xx` / `http.unhandled_rejection`. The Phase B incident builder keys off `http.unhandled_rejection` as a process-fatality marker.

## 2026-04-29 — WebSocket lifecycle diag emits

### Post-merge fixes

- Invalid-id WS branch no longer emits `ws.connected` (preserves connect/disconnect matching invariant). Previously, the early-return path in [`server-logs.ts`](../../../apps/api/src/routes/server-logs.ts) and [`server-install.ts`](../../../apps/api/src/routes/server-install.ts) emitted `ws.connected` then immediately closed the socket and returned BEFORE registering the `socket.on('close', ...)` listener — the close event fired without a listener, so no `ws.disconnected` was ever produced. This broke the documented invariant that every connect has a matching disconnect. Fix: drop the `ws.connected` emit on the invalid-id branch entirely. Observability for malformed-uuid sockets is low value, and the route still sends `{error:'invalid_id'}` and closes the socket. Covered by a new vitest case in [`apps/api/test/diag-ws.test.ts`](../../../apps/api/test/diag-ws.test.ts) that drives both `/logs/ws` and `/install/ws` with `INVALID` as the `:id` and asserts neither `ws.connected` nor `ws.disconnected` fires.

### Added

- `apps/api/src/routes/live.ts`, `apps/api/src/routes/server-logs.ts`, `apps/api/src/routes/server-install.ts` (Phase A2 Task 14) now emit three new diag kinds covering the WebSocket connection lifecycle:
  - `ws.connected` (severity `info`, payload `{ url, [serverId] }`) — fires on connection handler entry, before any application-level frame.
  - `ws.disconnected` (severity `info`, payload `{ code, reason, url, [serverId] }`) — fires from `socket.on('close', ...)`. `reason` is `Buffer.toString().slice(0, 200)` so malformed clients cannot bloat `diag:queue` payloads.
  - `ws.error` (severity `warn`, payload `{ errorMessage, url, [serverId] }`) — fires from `socket.on('error', ...)`. Does NOT replace `ws.disconnected`; both fire when an error also drops the socket.
- The per-server routes (`/api/v1/servers/:id/logs/ws`, `/api/v1/servers/:id/install/ws`) populate `serverId` from the `:id` URL param; the global `/api/v1/ws/live` route leaves `serverId` unset. Invalid `:id` strings produce NO diag events at all (see post-merge fix above) — the route closes the socket with `{error:'invalid_id'}` without emitting.
- Each `app.diag.emit(...)` is wrapped with `.catch(() => undefined)` so a Redis hiccup never propagates back into the WebSocket handler.
- `apps/api/test/diag-ws.test.ts` — three vitest cases driving the WebSocket protocol against a real Fastify server (started with `app.listen({ port: 0 })`) and asserting the captured diag emits include `ws.connected` and `ws.disconnected` with the expected `serverId` and payload shape. `ws.error` is exercised by code review only because simulating a real socket error from the client side is flaky.

### Changed

- `apps/api/test/install-ws.test.ts`, `apps/api/test/live-bus.test.ts`, `apps/api/test/server-logs.test.ts` — register `diagPlugin` and decorate `app.redis` with a no-op `xadd` stub so the new emits fire without throwing. The previous empty-redis-stub fixture broke the moment the WS routes started calling `app.diag.emit(...)` from their lifecycle handlers.

### Migration notes

No DB schema changes. No new env vars. Consumers reading `diagnostic_events` will start seeing rows where `component='api'` and `kind` matches `ws.connected` / `ws.disconnected` / `ws.error`. The Phase B detector keys off these kinds for the "WS storm" panel.

## 2026-04-29 — heartbeat-watch plugin

### Added

- `apps/api/src/plugins/heartbeat-watch.ts` — new plugin that runs a 30 s `setInterval` polling `worker:heartbeat:<name>` keys for the six known workers (`rcon`, `log-ingest`, `audit-archiver`, `event-partition`, `diag-flush`, `metrics-sampler`). Emits two diag kinds:
  - `worker.heartbeat_lost` (severity `error`) — fires exactly once per outage when a heartbeat key has been absent for more than 30 s. Tracked via a closure-local `Set<string> reported` so duplicate emits are impossible during the same outage.
  - `worker.heartbeat_recovered` (severity `info`) — fires when the key reappears AFTER `worker.heartbeat_lost` was reported. Subsequent ticks while the key is healthy are silent until the next outage.
- `inFlight` re-entrancy guard mirrors `pgHealthTick` — a slow Redis `pttl` round-trip cannot cause overlapping ticks. Tick errors are caught and logged at `warn` ("heartbeat-watch tick failed").
- `app.heartbeatWatchTick: () => Promise<void>` decorator so tests can drive the tick deterministically without waiting for the interval.
- `apps/api/test/diag-heartbeat-watch.test.ts` — 3 vitest cases covering: single-emit per outage (Date.now monkey-patched to advance past the 30 s threshold); recovery-edge after a reported outage; clean startup is silent.
- `apps/api/test/integration/harness.ts` — registers `heartbeatWatchPlugin` after `diagPlugin` so integration tests can call `app.heartbeatWatchTick()`.

### Changed

- `apps/api/src/server.ts` — plugin registration order becomes `redis → diag → db-health → heartbeat-watch → live-bus → ...`. The new plugin is registered after `dbHealthPlugin` and depends only on `app.redis` (already decorated by `redisPlugin`) and `app.diag` (decorated by `diagPlugin`).

### Migration notes

No DB schema changes. No new env vars. One additional `pttl` round-trip per worker per 30 s tick (six round-trips total) — negligible Redis load. Consumers reading `diagnostic_events` will start seeing rows with `component='api'` and `kind` equal to `worker.heartbeat_lost` or `worker.heartbeat_recovered`.

## 2026-04-28 — connector plugins emit diag events on pg/redis state changes

### Post-merge fixes

- In-flight guard on `pgHealthTick` to prevent overlapping invocations during long pg hangs. The 30 s `setInterval` in `apps/api/src/plugins/db-health.ts` now checks an `inFlight` boolean closure flag before kicking off a new tick; if the previous tick is still pending (e.g. during an unreachable-postgres hang), the next interval fires a debug-level log and skips the call. The recovery-edge contract (`pg.ping.ok` only on the first OK after a prior fail) is preserved because two ticks can no longer race on the shared `PG_DOWN` WeakMap. Covered by a new vitest `vi.useFakeTimers()` case in `apps/api/test/diag-connector.test.ts` that drives the live `setInterval` against a never-resolving `app.db.execute` stub and asserts only one `execute` call lands across two 30 s windows.

### Added

- `apps/api/src/plugins/redis.ts` — three new ioredis listeners translate connection-state events into diag emits. Each emit uses `app.diag?.emit(...).catch(() => undefined)` (optional chaining because the redis plugin registers BEFORE the diag plugin in [`server.ts`](../../../apps/api/src/server.ts)):
  - `error` → `redis.ping.fail` (severity `error`, payload `{ err }`). Sets a module-local `redisDown` flag.
  - `reconnecting` → `redis.reconnect.attempt` (severity `warn`, payload `{ delayMs }`).
  - `ready` AFTER a prior `error` → `redis.reconnect.success` (severity `info`, payload `{}`). Resets `redisDown`. Clean startup is silent.
- `apps/api/src/plugins/db-health.ts` — new plugin running a 30 s `setInterval` that executes `SELECT 1` against `app.db`. Emits `pg.ping.fail` (severity `error`, payload `{ err }`) on every throw and `pg.ping.ok` (severity `info`, payload `{}`) only as a recovery signal (first OK after a prior fail; clean startup is silent). Per-app `pgDown` state is tracked in a `WeakMap<FastifyInstance, boolean>`. The exported `pgHealthTick(app)` helper drives the tick deterministically for tests; the timer is `unref()`-ed so it does not block process exit, and the `onClose` hook clears it. Registered in [`server.ts`](../../../apps/api/src/server.ts) AFTER both `database` and `diag`.
- `apps/api/test/diag-connector.test.ts` — focused integration test (9 cases):
  - Three redis-listener cases: `error` → `redis.ping.fail` followed by `ready` → `redis.reconnect.success`; `ready` without prior error stays silent (clean-startup regression); `reconnecting` → `redis.reconnect.attempt`. Drives the real redis plugin against a live ioredis client and stubs `app.diag.emit` to capture events.
  - Three pg-health cases: throw-then-success produces fail+ok; clean steady-state produces zero events; consecutive failures produce many `pg.ping.fail` but only one `pg.ping.ok` on recovery.
  - Three plumbing-regression cases: `app.redis` is a real `Redis` instance after the redis plugin runs; `app.db` decoration is honoured by the db-health plugin without registering the database plugin.

### Changed

- `docs/components/api/api.md` — new "Connector listener event kinds" subsection under "Decorations" listing the five diag kinds (`redis.ping.fail`, `redis.reconnect.attempt`, `redis.reconnect.success`, `pg.ping.fail`, `pg.ping.ok`) + payload shapes + clean-startup-silent semantics.
- `docs/components/api/flows.md` — new "Connector listeners" subsection under "Diagnostic emission" with ASCII flows for both redis and pg-health, including the `redisDown` flag rationale and the 30 s tick wiring.
- `apps/api/src/server.ts` — registers `dbHealthPlugin` immediately after `diagPlugin`.

### Migration notes

No DB schema changes. No new env vars. The 30 s pg-health tick adds one `SELECT 1` per app process every 30 s — negligible load on a healthy postgres. Consumers reading `diagnostic_events` will start seeing rows where `component='api'` and `kind` matches `redis.{ping.fail,reconnect.attempt,reconnect.success}` / `pg.{ping.fail,ping.ok}`. Phase B detector logic keys off these kinds for the "infra degraded" panel.

## 2026-04-28 — bridge plugin emits diag events on connect / disconnect / rpc-error / rtt-outlier

### Added

- `apps/api/src/plugins/bridge.ts` — the singleton `BridgeClient` constructed by this plugin now has four listeners attached at registration time. Each listener translates a `BridgeClient` event into one `app.diag.emit` call:
  - `connected` → `bridge.client.connected` (severity `info`, payload `{rttMs, version, hostname}`)
  - `disconnected` → `bridge.client.disconnected` (severity `error`, payload `{reason}` where `reason ∈ {'socket-error', 'socket-closed', 'frame-decode-error', 'client-closed'}`)
  - `rpc-error` → `bridge.rpc.error` (severity `warn`, payload `{method, code, message}`)
  - `rtt` (only when > 50 ms) → `bridge.rtt.outlier` (severity `warn`, payload `{rttMs, thresholdMs: 50}`)
  All four `app.diag.emit` calls are wrapped with `.catch(() => undefined)` so a Redis hiccup never propagates into the bridge layer. The 50 ms threshold is fixed in the constant `RTT_OUTLIER_THRESHOLD_MS` at the top of the plugin module.
- `apps/api/test/diag-bridge.test.ts` — five-case integration test that registers the diag plugin + bridge plugin, captures `app.diag.emit` calls, drives the `BridgeClient` event surface directly via `bridge.emit('connected'|...)`, and asserts the expected diag events fire (kind / severity / payload). Includes a regression case proving listener-side diag failures do not throw.

### Changed

- `packages/bridge-client/src/client.ts` — `BridgeClient` now extends a `TypedEmitter<BridgeClientEvents>`-wrapped `EventEmitter`. See [`docs/components/bridge-client/changelog.md`](../bridge-client/changelog.md). The api side consumes those events via the listeners above.
- `docs/components/api/api.md` — new "Bridge listener event kinds" subsection under "Decorations" listing the four diag kinds + payload shapes.
- `docs/components/api/flows.md` — new "Bridge listener (background, every RPC)" subsection under "Diagnostic emission" with the listener wire-up flow.

### Migration notes

No DB schema changes. No new env vars. Consumers reading `diagnostic_events` will start seeing rows where `component='api'` and `kind` matches `bridge.client.connected` / `bridge.client.disconnected` / `bridge.rpc.error` / `bridge.rtt.outlier`. The bridge-heartbeat plugin's existing 5 s ping loop guarantees a steady stream of `bridge.rtt.outlier` events whenever the bridge is slow + a `bridge.client.connected` on the first heartbeat after each api restart.

## 2026-04-28 — status reconciler emits `container.exited` / `container.unexpected_exit`

### Added

- `apps/api/src/plugins/status-reconciler.ts` — every observed `running → stopped` transition now emits a diag event into `diag:queue`. Kind is `container.exited` when the Redis fence `stop:requested:{server_id}` (set by `POST /servers/:id/stop` with TTL 300 s, see Task 7) is present, otherwise `container.unexpected_exit`. Severity is `info` when `exit_code === 0`, else `error`. Payload: `{ exit_code, oom_killed, signal, finished_at, started_at }`. When the fence is set, the reconciler also emits a follow-up `server.stop.reconciler_confirmed` (info, payload `{ exit_code }`) — this is the cap-off the stop handler in [`routes/servers.ts`](../../../apps/api/src/routes/servers.ts) deferred to the reconciler in Task 7.
- The reconciler reads the fence with `GET` (non-consuming) and lets it expire naturally; the next `/stop` request refreshes the TTL, so a fast stop→start→stop cycle within 5 minutes still produces correct classification.
- `apps/api/test/diag-reconciler.test.ts` — focused integration test (4 cases) seeding a `running` server, stubbing `app.bridge.containerInspect` to return an exited state with controllable `exit_code` / `oom_killed` / `error`, optionally setting the fence, and asserting `app.diag.emit` was called with the expected `kind` / `severity` / `payload`.

### Changed

- `packages/bridge-client/src/types.ts` — `ContainerInspectResult` gained two optional fields: `oom_killed?: boolean` and `error?: string`. Both default to undefined when omitted by the bridge; the reconciler defaults them to `false` and `null` respectively. The Go bridge does not yet populate these fields — surface area is in place so the future Go-side change (mapping Docker `State.OOMKilled` and `State.Error`) is a one-line wire-up. With today's bridge build `oom_killed` is always `false` and `signal` is always `null` in emitted events.
- `apps/api/test/integration/harness.ts` — `FakeBridge.containerInspect` signature mirrors the new optional fields so tests can synthesize OOM/signal scenarios without a real Docker.
- `docs/components/api/api.md` — new "Lifecycle event kinds emitted by the status reconciler" subsection covering the three new kinds + the non-consuming fence semantics.
- `docs/components/api/flows.md` — new "Reconciler container-exit observation" subsection under "Lifecycle event sequences" with an ASCII flow describing the tick path that emits the events.

### Migration notes

No DB schema changes. No new env vars. Consumers reading `diagnostic_events` will start seeing rows where `component='reconciler'` and `kind` matches `container.exited` / `container.unexpected_exit` / `server.stop.reconciler_confirmed`. Detector logic in Phase B (Task 12) keys off these kinds.

## 2026-04-28 — server-lifecycle routes emit structured `server.*` diag events

### Added

- `apps/api/src/routes/server-install.ts` — install handler now emits `server.install.{requested,depot_seed,ufw_rule,container_run,verify,done,failed}` into `diag:queue`. Each emit carries `serverId`, `actorSteamId64` (when authenticated), `requestId`, and a structured `payload` (`durationMs`, `seededCount`, `proto/port/status`, `container_id`, etc.). Failures fire `server.install.failed` with `payload.stage` + `errorMessage`. Per-step ufw failures fire as `severity='error'` without aborting the install (matches the pre-existing behaviour).
- `apps/api/src/routes/servers.ts` — start/stop/soft-delete handlers now emit `server.start.{requested,done,failed}`, `server.stop.{requested,broadcast,end_match,container_stop,done,failed}`, and `server.soft_delete.{requested,done,failed}`. The stop handler also `SET stop:requested:{server_id} EX 300` at request time so the status-reconciler (Task 8) can distinguish a planned stop from a crash. Broadcast / end-match RCON sub-steps emit per-attempt with `payload.ok`.
- `apps/api/src/routes/server-archive.ts` — restore handler emits `server.restore.{requested,done}`. The `requested` event uses the OLD archived server's id; the `done` event uses the NEW server's id and includes `archive_id` + `new_server_id` in payload.
- `apps/api/test/diag-lifecycle.test.ts` — focused integration test (5 cases) that stubs `app.diag.emit` with a capture array, drives each lifecycle endpoint via `app.inject()`, and asserts the expected `kind` strings appear plus the Redis fence is set on stop.

### Changed

- `docs/components/api/api.md` — new "Lifecycle event kinds emitted by API routes" section under "Decorations" listing every event kind per route family.
- `docs/components/api/flows.md` — new "Lifecycle event sequences" subsection under "Diagnostic emission" with one ASCII flow per route (install / start / stop / soft-delete / restore).

### Migration notes

No DB schema changes. No new env vars. The new events flow through the existing `diag:queue` Redis Stream → `worker-diag-flush` → `diagnostic_events` table; consumers reading `diagnostic_events` will start seeing rows where `component='api'` and `kind` matches `server.*`.

The Redis key `stop:requested:{server_id}` is set on every successful stop request with TTL 300 s. It is currently consumed only by the stop-flow itself; the reconciler will read it in Task 8 to choose between `container.exited` (planned) vs `container.unexpected_exit` (crash) when emitting its own diag events.

## 2026-04-28 — `app.diag` / `request.diag` Fastify decoration

### Added

- `apps/api/src/lib/diag.ts` — fastify-plugin that wires `@squad/diag` into the API. Decorates `app.diag: Diag` and adds an `onRequest` hook that builds a per-request `req.diag` wrapper auto-injecting `requestId = req.id` (or honouring an explicit `requestId` in the event payload). Registered in [`server.ts`](../../../apps/api/src/server.ts) immediately after `redisPlugin` and before any routes. Also wired into the integration test harness ([`apps/api/test/integration/harness.ts`](../../../apps/api/test/integration/harness.ts)).
- `apps/api/test/diag-plugin.test.ts` — focused unit test that proves the decoration installs both `app.diag` and `request.diag`, and that `req.diag.emit` threads `req.id` while preserving an explicit `requestId` set by the caller.

### Changed

- `apps/api/package.json` — added `@squad/diag` workspace dependency.
- `docs/components/api/api.md` — new "Decorations" reference table covering `app.db / app.redis / app.bridge / app.diag / request.diag / request.requestId / …`.
- `docs/components/api/flows.md` — new "Diagnostic emission" flow describing how the plugin is registered, how `req.diag.emit` is built per-request, and the test-stub contract (`app.diag.emit = …` reroutes both module-level and per-request emits because the hook re-reads `app.diag` at emit time).

### Migration notes

No DB or runtime configuration changes. No new env vars. Existing routes are unchanged — they will start emitting events in subsequent tasks (Task 7+) by calling `req.diag.emit({...})`.

## 2026-04-28 — `GET /api/v1/host/disk-usage?refresh=1` (cache bypass)

### Changed

- `GET /api/v1/host/disk-usage` now accepts an optional Zod-coerced boolean query parameter `refresh`. When truthy (`?refresh=1`) the API forwards `{ force: true }` to `bridge.panelDiskUsage()`, instructing the bridge to bypass its 5-minute cache and recompute (`du -sb` + `docker system df` + `statvfs`). The fresh value is written back into the bridge cache so the next non-force call sees it immediately. No new permission check — the existing `host:view` requirement covers it.
- `apps/api/src/routes/host.ts` — added the Zod querystring schema, threads `refresh` into the bridge call.
- `apps/api/test/integration/harness.ts` — `FakeBridge.panelDiskUsage` now takes an optional `{ force?: boolean }` argument so tests can assert the API forwards the flag.
- `apps/api/test/host-disk-usage.test.ts` — added a fifth case proving that `?refresh=1` causes a `{ force: true }` invocation and that the unflagged endpoint passes `undefined`.

## 2026-04-28 — `GET /api/v1/host/disk-usage` (panel disk breakdown, Phase B1)

### Added

- `GET /api/v1/host/disk-usage` (RBAC `host:view`, no audit) — wraps `bridge.panelDiskUsage()` and appends two derived fields: `panel_pct` (panel's share of host total in percent) and `other_pct = max(0, host_used_bytes / host_total_bytes * 100 - panel_pct)`. Both fall back to `0` when `host_total_bytes <= 0` so a zero-capacity bridge response never produces `NaN`. No API-side cache — the bridge already caches the heavy `du`/`docker df` walk for 5 min.
- `apps/api/test/host-disk-usage.test.ts` — 4 integration tests (happy path with derived percentages, `host_total_bytes=0` edge case, 403 for a session with no role, 401 without a session).

### Changed

- `apps/api/test/integration/harness.ts` — `FakeBridge` interface and `makeFakeBridge()` now expose `panelDiskUsage` so tests can stub the new bridge method without a type-error.

### Added

- `STALE_INSTALL_AFTER_MS` watchdog (30 min) inside the reconciler tick. Rows in `status='installing'` whose `updated_at` is older than the threshold get auto-flipped to `'failed'` with a `server.status` LiveEvent. Prevents indefinite "Установка" rows after an api crash mid-install.
- `TICK_BUDGET_MS` (12 s) overall tick deadline. The tick races `Promise.allSettled` against a budget timer; servers that don't finish before budget retry on the next interval. Surfaced as `last_tick_budget_exceeded` in `/api/v1/health/reconciler`.
- Boot-time recovery log: on `onReady` the reconciler logs at info level `'reconciler: ready — running initial recovery tick' rows=N intervalMs=4000` so an api restart announces what it's about to converge.
- `stale_installs_failed` counter in the reconciler stats payload (cumulative across the process lifetime).

### Changed

- `apps/api/src/plugins/status-reconciler.ts` — `TRANSIENT_STATES` now contains only docker-owned states: `starting`, `stopping`, `running`, `stopped`, `ready`. Rows in `installing` and `failed` are deliberately untouched by the docker→DB mapping (those are owned by the install pipeline and the operator). The previous wider set would have flipped a fresh `installing` row to `stopped` whenever Docker reported `not_found`, masking the install in progress.
- `apps/api/src/plugins/status-reconciler.ts` — per-server `containerInspect` now runs in parallel via `Promise.allSettled` instead of a sequential `for` loop. A single slow bridge call no longer drags the whole tick. With the 10 s per-call timeout already enforced by `BridgeClient`, the worst-case tick duration is bounded by `TICK_BUDGET_MS`.
- `apps/api/src/routes/servers.ts` — `POST /servers/:id/start` and `POST /servers/:id/restart` now write `status='starting'` + emit `server.status` LiveEvent BEFORE calling the bridge (`containerRun` / `containerStart`). Symmetric with the `/stop` change in the previous patch — a process crash mid-bridge-call leaves a state the reconciler can converge.
- `apps/api/test/integration/status-reconciler.integration.test.ts` — added 4 fail-safe tests: reconciler does NOT touch `installing` rows on `not_found`, watchdog flips ancient `installing` to `failed`, parallel-inspect bound (slow server doesn't delay fast), startup recovery tick path.
- `apps/api/test/status-reconciler.test.ts` — added unit tests for the new constants (`installing`/`failed` exclusion, `STUCK_CANDIDATE_STATES` membership, `TICK_BUDGET_MS` and `STALE_INSTALL_AFTER_MS` invariants).
- `apps/api/test/integration/servers.test.ts` — added eager-start regression: assert `containerRun` sees `servers.status='starting'` already in the DB.

### Migration notes

- Operations: a row that was previously in `installing` for >30 min will now flip to `failed` on the next reconciler tick after deploy. If you have intentional long-running installs (e.g. depot_update on a slow link) this is the threshold; tune `STALE_INSTALL_AFTER_MS` upward if needed.
- The reconciler no longer touches `installing` rows during normal operation — install-progress remains the sole writer until either it finishes (→ `running`/`failed`) or the watchdog flips it (→ `failed`).
- API container needs a rebuild to pick up these changes: `docker compose build api && docker compose up -d api`.

## 2026-04-26 — Bridge: case-insensitive docker error detection

### Fixed

- `apps/bridge/internal/runner/docker.go` — `Inspect` previously matched only `"No such object"` (capital N) when classifying a missing container as `state: "not_found"`. Docker on this host writes `"no such object"` lowercase, so the matcher missed it and the bridge returned a `runtime_error` to callers (the status reconciler swallowed the throw and the DB row stayed in `stopping` indefinitely — root cause of the "Server stuck on Остановка for 2 hours" incident). Fix: lowercase the message before substring-checking. Same latent bug fixed proactively in `Stop` and `Rm` (which also matched `"No such container"` capitalized).
- `apps/bridge/internal/runner/docker_test.go` — added 4 regression tests: lowercase `no such object` on `Inspect`, lowercase `no such container` on `Stop`/`Rm`, and a re-affirmed uppercase `No such object` test.

## 2026-04-26 — Status reconciler hardening + manual reconcile + health visibility

### Added

- `POST /api/v1/servers/:id/reconcile` — forces a single-server `container_inspect` + DB sync. Returns `{previous_status, new_status, changed, inspected_state, inspected_running}`. 502 `bridge_unavailable` on bridge throw, 404 on unknown/soft-deleted id. Permission `server:view`. Audit `server.reconcile`.
- `GET /api/v1/health/reconciler` — surfaces `last_tick_at`, `last_tick_duration_ms`, `last_tick_servers_inspected`, `consecutive_tick_errors`, `stuck_servers[]` (rows in `starting`/`stopping`/`installing` with `updated_at` older than 90 s), `bridge_failures_by_server`, and a derived `healthy` boolean.
- `apps/api/test/status-reconciler.test.ts` — pure unit tests on `mapState` (case-insensitivity, all docker states, unknown-state guard) and reconciler constants.
- `apps/api/test/integration/status-reconciler.integration.test.ts` — 10 integration tests against a real DB schema: status flips for exited/running/not_found/unknown, per-server consecutive bridge-failure counter (increment + reset), `tickNow()` semantics, manual reconcile happy + 502 + 404 paths, `/health/reconciler` end-to-end including stuck-server detection.

### Changed

- `apps/api/src/routes/servers.ts` — `POST /api/v1/servers/:id/stop` now writes `servers.status='stopping'` and emits the `server.status` LiveEvent **before** the RCON broadcast + 15 s wait + `container_stop`. Previously the status flip happened after the slow bridge sequence, leaving the UI stale for ~75 s and a process crash mid-stop leaving a permanently inconsistent row. The reconciler resolves the row to `stopped` once Docker reports `exited`.
- `apps/api/src/plugins/status-reconciler.ts` — extracted pure `mapState(dockerState, running): {status, known}`; `known=false` for unmapped states leaves the DB untouched and logs `warn 'unknown docker state'` instead of silently skipping. Added per-server consecutive-failure counter for `container_inspect` errors, with escalating log levels (debug → warn at 5/30/every 60th). First tick fires on `onReady`, not after one interval. Decorated `app.statusReconciler` with `{stats(), reconcileOnce(id), tickNow()}` so routes can interact with the reconciler without re-implementing it.
- `apps/api/src/plugins/live-bus.ts` — extended `LiveEvent.server.status.data.source` union with `'stop' | 'start' | 'restart'` so route-emitted status events are distinguishable from reconciler-emitted ones.
- `apps/api/src/plugins/health.ts` — new `/api/v1/health/reconciler` route reads `app.statusReconciler.stats()`.
- `apps/api/test/integration/harness.ts` — wired the long-declared `withStatusReconciler` flag to actually register the reconciler plugin; without it tests get a no-op stub `app.statusReconciler` so `POST /reconcile` resolves cleanly.

### Migration notes

- The new `LiveEvent` source values are additive; the WS frame schema accepts them without UI changes (the dashboard ignores the source field today). Worker components that re-publish `server.status` are unaffected.
- The DB schema is unchanged; no migration required.
- Operations: when a server is stuck in `Остановка`/`Запускается`/`Установка`, `curl /api/v1/health/reconciler` first, then `POST /api/v1/servers/:id/reconcile` to force a resolution.

## 2026-04-26 — Bundles C+D: server soft-delete with config backup, archive, restore-configs

### Added

- `apps/api/src/lib/server-delete.ts` — `softDeleteServer(ctx, serverId): DeleteResult`. Phase 1 reads every `ALLOWED_CONFIG_FILES` via `bridge.fileRead` and inserts one `config_versions` row per file (`message = 'deletion-backup-marker <iso>'`); 0 reads aborts with throw. Phase 2 best-effort `containerStop({timeout_sec:30})` + `containerRm`. Phase 3 best-effort `bridge.directoryDelete` on `${PANEL_CONFIGS_ROOT}/${id}` and `${PANEL_SAVED_ROOT}/${id}`. Phase 4 best-effort `ufwRule({action:'remove'})` × 4 ports. Phase 5 `UPDATE servers SET deleted_at, deleted_by_steam_id64, deletion_backup_marker_id`.
- `apps/api/src/lib/server-restore.ts` — `restoreConfigsFromArchive(ctx, newServerId, archiveServerId)`. Reads `config_versions` rows with `message LIKE 'deletion-backup-marker%'`, dedupes by filename (asc-by-created), skips `Rcon.cfg`, `bridge.fileAtomicWrite`s onto the new server's ServerConfig dir, inserts a fresh `config_versions` row per overlay (`message = 'restored from server <id> backup <iso>'`).
- `apps/api/src/routes/server-archive.ts` — five new routes:
  - `GET /api/v1/servers/archive` — list soft-deleted (`server:view`).
  - `GET /api/v1/servers/archive/:id` — detail + dedup'd backup list (`server:view`).
  - `GET /api/v1/servers/archive/:id/configs/:filename` — read backup content (`config:view`).
  - `POST /api/v1/servers/archive/:id/restore` — create a NEW row from the archive metadata, 409 `slug_in_use` against partial unique index (`server:install`, audit `server.restore`).
  - `POST /api/v1/servers/:id/restore-configs` — overlay backup configs onto a freshly-installed server (`config:edit`, audit `server.restore_configs`).
- `apps/api/test/server-delete.test.ts` — orchestrator phases against fake bridge, idempotency.
- `apps/api/test/server-archive.test.ts` — archive + restore route HTTP surface, 404/409 paths.
- `apps/api/test/e2e/server-delete-live.e2e.test.ts` — live DELETE smoke.
- `apps/api/test/e2e/server-delete-restore-lifecycle.e2e.test.ts` — install → DELETE → restore → re-install → restore-configs → start → assert restored cfg sha matches.

### Changed

- `apps/api/src/routes/servers.ts` — `DELETE /api/v1/servers/:id` now invokes `softDeleteServer` and returns the full `DeleteResult` instead of dropping the row. Emits `server.deleted` LiveEvent on success. List/detail/start/stop/restart routes filter `WHERE deleted_at IS NULL`; soft-deleted ids 404.
- `apps/api/src/routes/server-configs.ts`, `apps/api/src/routes/server-install.ts`, `apps/api/src/routes/server-logs.ts` — same `deleted_at IS NULL` filter so a deleted server cannot be edited or re-installed at the old id.
- `apps/api/src/server.ts` — registers `archiveRoutes`.
- `packages/bridge-client/src/client.ts` — added `directoryDelete({path}) → {removed: boolean}` (used by phase 3).

### Migration notes

- Requires DB migration `0013_servers_soft_delete` and bridge release containing `directory_delete`. Roll out the migration and the bridge first, then deploy api.
- DELETE response shape changed from `{ ok: true }` to a full `DeleteResult` object. UI clients that ignored the body are unaffected; programmatic clients that asserted on the exact body need an update.
- DELETE on an already-soft-deleted id now returns 404 (was: 200 idempotent). Audit-log consumers will see one row per delete event, never two.

## 2026-04-26 — Bundle E: live-bus WebSocket + Redis pub/sub fan-out

### Added

- `apps/api/src/plugins/live-bus.ts` — process-local `EventEmitter` plus a Redis subscriber on `live-bus` and `rcon:status:changed` channels. `app.liveBus.publish()` emits to in-process listeners and replicates over Redis to other API replicas; `app.liveBus.subscribe(cb)` returns an unsubscribe handle. Falls back to single-process mode when the Redis client lacks `duplicate()` (test fixtures).
- `apps/api/src/routes/live.ts` — `GET /api/v1/ws/live` (permission `server:view`, `audit: false`). Forwards every `LiveEvent` to the connected socket. Server pings every 10 s; client must reply `{"type":"pong"}` within 30 s or the socket is closed with code 4000.
- `apps/api/test/live-bus.test.ts` — three vitest cases: forwards `server.status` events to the socket, accepts client `pong` frames without disconnect, releases subscriber handlers on socket close.

### Changed

- `apps/api/src/plugins/status-reconciler.ts` — emits `server.status` LiveEvent on every successful state transition.
- `apps/api/src/plugins/bridge-heartbeat.ts` — emits `bridge.connection` LiveEvent on edges (`up` ↔ `down`); steady-state ticks stay silent.
- `apps/api/src/server.ts` — registers `liveBusPlugin` between `redisPlugin` and `bridgePlugin`, and `liveRoutes` after the WebSocket plugin.

## 2026-04-26 — Phase 2 Tasks 7-19: coverage matrix gap-fill + roles.ts bug fix

### Added

- `apps/api/test/host-actions.test.ts` — expanded from 2 to 12 tests. New coverage: 401 on POST /host/restart, bridge 5xx → 502, GET /host/info (200, 401, 403 no-role), GET /host/metrics/history (200, bad seconds 400/422, 401, 403 no-role).
- `apps/api/test/me-tokens.test.ts` — new tests: 401 on POST and DELETE /me/tokens, 409 when 25-token limit exceeded.
- `apps/api/test/roles-crud.test.ts` — expanded to 15 tests. New coverage: `description=null` PUT clears field, invalid color → 400/422, duplicate name → 409, Owner immutability (PUT + DELETE → 400), 401 on GET routes, 404 on unknown id.
- `apps/api/test/audit-entry.test.ts` — added 4 HTTP integration tests: 401 without auth, happy path paginated result, pagination offset, `page_size` out-of-range → 400/422.
- `apps/api/test/users-list.test.ts` — added 4 HTTP integration tests: 401 without auth, happy path (owner in list), 403 for null-role player, null-role player absent from INNER JOIN result.
- `apps/api/test/player-role-assign.test.ts` — added 9 HTTP integration tests covering GET /players (401, happy path, ASCII search, steamId64 search, Cyrillic search, 403 no-role) and PUT /players/:steamId/role (assign role → 200, 404 bad role_id, 409 last-owner guard).
- `apps/api/test/auth-sessions.test.ts` — new coverage: 401 on DELETE /me/sessions without auth, revoke own session and 401 for that route, 401 on GET /me/sessions, session count validation.
- `apps/api/test/test-isolation.regression.test.ts` — added three exclusion patterns for `security/sql-injection`, `security/permission-matrix`, and `security/xss-smoke` (all use `buildIntegrationApp` isolated schemas; the grep-based checker had no way to know that).

### Fixed

- `apps/api/src/routes/roles.ts` — pre-existing production bug: `POST /api/v1/roles` and `PUT /api/v1/roles/:id` returned 500 on duplicate name instead of 409. `DrizzleQueryError` wraps the Postgres error such that `.code` is `undefined` and the actual PG code `'23505'` is at `.cause.code`. Fixed by checking both `err.code` and `err.cause?.code`.

## 2026-04-26 — Phase 6 Task 56: audit chain property tests

### Added

- `apps/api/test/property/audit-chain.test.ts` — property-based fuzz test (`@fast-check/vitest`, 10 runs × up to 20 random rows). Verifies that the DB trigger correctly builds the sha256 hash chain across random `audit_log` insertions: `prev_hash` links match, `row_hash` values match independent JS computation of `sha256(prev || canonical)`.

## 2026-04-26 — Phase 7 Tasks 57-60: security regression test suite

### Added

- `apps/api/test/security/permission-matrix.test.ts` — 3100 tests covering every permission-protected route × every permission key. `collectProtectedRoutes()` walks `onRoute` hooks on a minimal Fastify app; WebSocket routes excluded. All ~70 test users pre-created via `Promise.all` in `beforeAll`.
- `apps/api/test/security/sql-injection.test.ts` — 63 tests submitting 9 classic SQL injection payloads to 7 endpoint groups; asserts `200–499` status and tables still exist.
- `apps/api/test/security/xss-smoke.test.ts` — 4 tests verifying HTML stored as-is in JSON responses and `Content-Type: application/json`.
- `apps/api/test/security/cookie-security.test.ts` — 5 tests verifying `__Host-sid` cookie has `HttpOnly + Secure + SameSite=Lax + Path=/`.
- `apps/api/vitest.security.config.ts` — dedicated vitest config for the security suite with `hookTimeout: 300_000` and `testTimeout: 30_000`.

### Changed

- `apps/api/vitest.config.ts` — raised `hookTimeout` from `30_000` to `120_000` ms. The parallel `buildIntegrationApp` + user-creation setup in the permission matrix was approaching the old limit.

## 2026-04-25 — Integration test harness: adapt to single-role / no-orgs RBAC model

### Changed

- `apps/api/test/integration/harness.ts`: removed `seedSystemRoles`, `organizationMembers`, `playerRoleAssignments`, `RoleName`, `setupRoutes` imports and all org-creation + M:N role-assignment code. Owner player is now seeded via a single `players` insert with `roleId` looked up from the migration-seeded roles table. `setupRoutes` replaced with `permissionsRoutes`, `rolesRoutes`, `usersRoutes`. `IntegrationHarness.seed.orgId` removed.
- `apps/api/test/integration/harness.test.ts`: removed `seed.orgId` assertion; replaced `/setup/check-env` smoke test with `/me`.
- `apps/api/test/integration/db-triggers.test.ts`: removed `organizations` insert for server FK setup; servers no longer have `orgId`.
- `apps/api/test/integration/players-plugins-depot.test.ts`, `servers.test.ts`, `host-actions.test.ts`: replaced `playerRoleAssignments` delete+insert with `players.update({ roleId })` for Viewer-demotion tests; updated permission key assertion `server:create` → `server:install`.
- `apps/api/test/auth-sessions.test.ts`: removed org/M:N seed logic; `seedAuthedPlayer` now sets `players.roleId` directly.
- `apps/api/test/auth-steam.test.ts`: removed `organizations`/`seedSystemRoles` setup; updated "no-access" test to use `panelMeta` instead of `organizations.settings`.

## 2026-04-25 — Task 8: Drop /setup wizard

### Removed

- `apps/api/src/routes/setup.ts` — deleted. `/api/v1/setup/check-env` and `/api/v1/setup/init` no longer exist; both return 404.
- `apps/api/test/setup.test.ts` — deleted (tested the removed routes).
- `apps/api/test/integration/setup-host-audit.test.ts` — deleted (broken harness; setup-related).
- `import setupRoutes` and `app.register(setupRoutes)` removed from `apps/api/src/server.ts`.

### Added

- `apps/api/test/setup-removed.test.ts` — regression guard: asserts `server.ts` contains no `setupRoutes` reference and `routes/setup.ts` does not exist.

### Migration notes

There is no API migration. The `/api/v1/setup/*` surface was always unauthenticated; removing it reduces attack surface. First-login Owner claim is handled by `claimFirstOwner` in `auth-steam.ts` (unchanged).

## 2026-04-25 — Task 7: RBAC routes — permissions / roles / users / player-role

### Added

- `apps/api/src/routes/permissions.ts` — `GET /api/v1/permissions` returns full `PERMISSIONS` registry array from `@squad/shared-config`. Requires `role:view`.
- `apps/api/src/routes/roles.ts` — CRUD for `/api/v1/roles/*`. Owner role (is_system_role=true, name=Owner) is immutable: PUT/DELETE return `400 owner_role_immutable`. POST returns 409 on duplicate name. PUT and DELETE invalidate the permission cache for all carriers of the role via `invalidatePermissionCacheForRole`.
- `apps/api/src/routes/users.ts` — `GET /api/v1/users` — players with non-NULL `role_id`, joined to `roles`, sorted by `last_seen_at DESC`.
- `GET /api/v1/players/:steamId/role` — returns the player's current single role or `{role: null}`. Requires `user:view`.
- `PUT /api/v1/players/:steamId/role` — assigns or clears a single role. Owner-lockout: 409 `cannot_remove_last_owner` if the change would leave zero Owners. Invalidates the player's permission cache.

### Changed

- `apps/api/src/routes/players.ts` — removed M:N endpoints (`GET /roles`, `POST /roles`, `DELETE /roles/:roleId`) and the legacy `GET /api/v1/roles` endpoint. Added new single-role endpoints above. Imports of `playerRoleAssignments` removed.
- `apps/api/src/routes/host.ts` — removed old `GET /api/v1/permissions` endpoint that used removed `SYSTEM_ROLE_CLEARANCE` / `SYSTEM_ROLE_PERMISSIONS` exports. Replaced by `routes/permissions.ts`.
- `apps/api/src/server.ts` — registers `permissionsRoutes`, `rolesRoutes`, `usersRoutes`.
- `apps/api/test/audit-coverage.test.ts` — removed broken `setupRoutes` import (Task 8 will delete the file). Added the three new route plugins.

### Removed

- `apps/api/test/players-roles.test.ts` — M:N player-role test deleted (old M:N table gone).

### Tests

- `apps/api/test/permissions-list.test.ts` — 5 unit tests on the PERMISSIONS registry shape.
- `apps/api/test/roles-crud.test.ts` — 8 direct-DB tests: Owner-guard, permission management, unique-name constraint, cache invalidation, FK cascade to players.
- `apps/api/test/player-role-assign.test.ts` — 6 direct-DB tests: role assignment, clearance, cache invalidation, Owner-lockout logic.
- `apps/api/test/users-list.test.ts` — 3 direct-DB tests: JOIN filter on non-NULL role_id.

## 2026-04-25 — Task 5: first-owner refactored to panel_meta

### Changed

- `apps/api/src/lib/first-owner.ts` — rewritten to use `panel_meta.first_owner_claimed` as the DB anchor instead of `organizations.settings`. Advisory lock key changed from `first_owner` to `panel_first_owner`. Sentinel write moved outside the transaction (non-fatal on failure). Role assignment via `UPDATE players SET role_id` instead of `INSERT INTO player_role_assignments` + `organization_members`.
- `apps/api/test/first-owner.test.ts` — replaced isolated-schema harness tests with direct-DB unit tests against the live DB. Saves and restores `panel_meta` singleton state in beforeEach/afterEach. Covers: claim, double-claim, sentinel fast-path, concurrent advisory-lock serialization, and missing-Owner-role error path.

### Removed

- No dependency on `organizations`, `organizationMembers`, `playerRoleAssignments` in `first-owner.ts`.

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
