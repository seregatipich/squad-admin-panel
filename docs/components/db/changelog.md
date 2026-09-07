# Changelog

All schema changes are recorded here in reverse chronological order, keyed by migration file. Dates are derived from the Drizzle journal (`packages/db/drizzle/meta/_journal.json`).

---

## 2026-09-07

### Remote log sources — `server_log_sources` (migration 0113)

**Files:** `packages/db/drizzle/0113_server_log_sources.sql`, `packages/db/src/schema/server-log-sources.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/migrations.regression.test.ts`

One row per external server describing where worker-log-ingest tails `SquadGame.log`: `kind` (`ssh` only, CHECK `server_log_sources_kind_chk`), `ssh_host`, `ssh_port`, `ssh_user`, `ssh_private_key_encrypted` (AES-GCM blob, same format as `server_credentials`), `ssh_public_key` (the `authorized_keys` line), `host_key_fingerprint` (trust-on-first-use pin, NULL until the first connect), `log_path`, `enabled`, `key_version`. `ON DELETE CASCADE` from `servers`.

---

## 2026-09-05

### External servers — `servers_runtime_enum` widened (migration 0112)

**Files:** `packages/db/drizzle/0112_server_runtime_external.sql`, `packages/db/src/schema/servers.ts`, `packages/db/src/admins-cfg-outbox.ts`, `packages/db/test/migrations.regression.test.ts`

`servers.runtime` may now be `'external'` besides `'container'`. An external row describes a Squad instance the panel does not host: `server_credentials.rcon_host` is non-NULL (the escape hatch that column always reserved) and the panel reaches it only over RCON/A2S. No column is added; the CHECK constraint is dropped and recreated with the wider set, so existing rows and the old value are untouched (additive, safe to promote).

#### Changed

- `enqueueAdminsCfgSyncForAllServers` fans out only to `runtime='container'` rows — an external server has no `Admins.cfg` under the panel's config tree.

---

## 2026-07-27

### DISCORD-5 — discord_role_mappings (migration 0099)

**Files:** `packages/db/drizzle/0099_discord_role_mappings.sql`, `packages/db/src/schema/discord-role-mappings.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/schema.test.ts`

New table `discord_role_mappings` (#152) — the panel role → Discord guild role mapping that `apps/workers/discord` drives every linked player's Discord roles from.

#### Added

- `discord_role_mappings(id, role_id, discord_role_id, enabled, created_at, updated_at)`. `role_id REFERENCES roles(id) ON DELETE CASCADE` — deleting a panel role takes its mapping with it.
- Unique index `discord_role_mappings_role_id_key` on `role_id`: one panel role maps to at most one Discord role, the cardinality SQSTAT's `vip_sync`/`moderator_sync` uses. Widening to N Discord roles per panel role means moving the index onto `(role_id, discord_role_id)`; the worker already computes over a set, so only the constraint would change.
- Index `discord_role_mappings_discord_role_id_idx` for the reconcile walk.
- The set of `discord_role_id`s in this table is exactly the set of Discord roles the panel manages — the worker never adds or removes anything outside it, so operators keep manual control of every other guild role.
- No `source` column: only `panel_role` exists today and the API synthesises it. Leaderboard-driven roles are a post-STATS-3 extension that will need their own columns.

**Journal note:** the entry is `idx: 84`, `when: 1783402900000`, inserted between `0098_player_discord_links` and `0101_server_daily_stats`. Its `when` is *lower* than the already-present `0101`–`0106` entries, so a database already migrated past `1783403100000` will not pick `0099` up from `pnpm --filter @squad/db migrate` — apply it by hand there. A fresh database (CI, new deployments) applies the whole journal in array order and is unaffected.
### LEAD-7 — seasons (migration 0102)

**Files:** `packages/db/drizzle/0102_seasons.sql`, `packages/db/sql/seasons.sql`, `packages/db/src/schema/seasons.ts`, `packages/db/src/leaderboard/season.ts`, `packages/db/src/leaderboard/aggregate.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`, `packages/db/test/seasons.test.ts`, `packages/db/test/leaderboard-aggregate.test.ts`

New table `seasons` (#178) — named leaderboard seasons. A season is an **arbitrary named interval**, not a calendar year: the aggregator materialises `player_stat_periods` rows with `period_type='season'` and `period_start = starts_at` (UTC day) over the explicit `[starts_at, ends_at]` window of the single active season. `player_stat_periods` is unchanged — `'season'` was already permitted by `player_stat_periods_period_type_chk`.

#### Added

- `seasons(id, name, starts_at, ends_at, status, finalized, created_at, updated_at)`. `status` is `upcoming|active|closed` (CHECK `seasons_status_chk`), `finalized` defaults to `false`.
- **`seasons_one_active`** — a partial unique index over a constant, `ON seasons ((status)) WHERE status = 'active'`. This is the storage-level enforcement of "at most one active season", and it is why the aggregator and the API resolve the active season with a bare `LIMIT 1` instead of defensively ordering. Drizzle expresses it as `uniqueIndex(...).on(sql\`(status)\`).where(...)`.
- CHECK `seasons_bounds_chk` — `ends_at > starts_at`. Unique index `seasons_name_key` on `name`; lookup index `seasons_status_idx` on `(status, starts_at)`.
- `loadActiveSeasonTarget(sql)` (`src/leaderboard/season.ts`) — returns the one season the aggregator should recompute, as a ready-made `RecomputePeriodInput`, or `null`. Only an **active, non-finalized** season qualifies, which is the whole mechanism behind "a finalized season is never recomputed again". The day bounds are formatted in SQL as `AT TIME ZONE 'UTC'` strings: they must be UTC days to line up with `player_daily_presence.day`, and the JS type of a `timestamptz` is not stable across callers — `drizzle()` replaces the postgres.js type parsers on the client it wraps, so the same tagged-template query yields a `Date` on a bare client but a session-local string on a wrapped one.
- `RecomputePeriodInput.range?: DayRange` — an explicit window overriding `periodDayRange()`. Required for `'season'`, for which `periodDayRange` returns `null`, which would otherwise widen the slice to all time. `recomputeLeaderboardPeriods` now takes `RecomputePeriodInput[]`; `PeriodDescriptor` stays structurally assignable, so existing callers are unaffected.

#### Fixed

- `recomputeLeaderboardPeriod`'s match window was built as `started_at < toDay::date + INTERVAL '1 day'`, whose result is a **local-time** timestamp. Presence is filtered on a `date` column holding UTC days, so on any deployment whose Postgres session `TimeZone` is not UTC the presence and match halves of the same period covered different spans — a match late on a period's last day fell outside its own period. Both edges are now pinned with `AT TIME ZONE 'UTC'`. Affects `day`/`week`/`month` as well as seasons.
### VIDEO-4 — media_publications + media_publish_settings (migration 0097)

**Files:** `packages/db/drizzle/0097_media_publications.sql`, `packages/db/src/schema/media-publications.ts`, `packages/db/src/schema/media-publish-settings.ts`, `packages/db/src/schema/index.ts`

Two new tables (#160) backing the fan-out of stored media to YouTube/Telegram.

#### Added

- `media_publications(id, media_id, destination, status, external_id, external_url, error, attempts, next_attempt_at, requested_by_player_id, created_at, updated_at)`. `media_id` `REFERENCES media_files(id) ON DELETE CASCADE`; `requested_by_player_id` `REFERENCES players(id) ON DELETE SET NULL` so provenance survives the requester's deletion.
- CHECKs `media_publications_destination_check` (`youtube`/`telegram`), `media_publications_status_check` (`queued`/`uploading`/`published`/`failed`) and `media_publications_attempts_nonneg`.
- Unique index `media_publications_media_destination_key` on `(media_id, destination)` — one publication per direction, so a repeat request is a `409` rather than a duplicate upload.
- Index `media_publications_due_idx` on `(status, next_attempt_at)` — the worker's claim predicate.
- **The table is the queue.** `worker-media-publisher` claims rows with `... WHERE status='queued' AND next_attempt_at <= now() FOR UPDATE OF p SKIP LOCKED` inside a CTE, then flips them to `uploading` in the same statement, so two replicas cannot take the same row. `attempts`/`next_attempt_at` are what make retry and backoff fall out of the schema instead of needing a stream.
- `status` deliberately does **not** distinguish "waiting on a YouTube daily quota" from "waiting on a backoff": both stay `queued`, and only `error`/`next_attempt_at` differ. A quota wall leaves `attempts` untouched, so an outage outside our control can never exhaust the retry budget and drive a row to `failed`.
- `external_url` is nullable **on success**: a Telegram message is only publicly addressable for an `@username` channel or a `-100…` supergroup. Storing a fabricated URL would later be used to justify deleting the local file.
- `media_publish_settings(id, release_local_file, updated_by_player_id, updated_at)` — singleton (`CHECK id = 1`, seeded by the migration), mirroring `banlist_publication_settings`. `release_local_file` defaults to **false**: primary storage is ours, and a deploy must not start discarding local evidence because a feature shipped. When enabled, a successful publish swaps `media_files.storage_path` for `external_url` in a single `UPDATE` — `media_files_exactly_one_location_check` forbids a row holding both or neither, so the swap cannot be two statements.
- No credential column anywhere: YouTube/Telegram secrets live only in the worker's environment.

**Journal note:** this migration's reserved `when` (`1783402700000`) was below the journal tip at merge time, which would have made Drizzle skip it on any database already migrated past `0106`. The entry uses `when: 1783403697000` instead — greater than the tip, keyed to the migration number so it cannot collide with a sibling making the same correction. The filename and `idx: 82` are unchanged.

### DISCORD-4 — player_discord_links (migration 0098)

**Files:** `packages/db/drizzle/0098_player_discord_links.sql`, `packages/db/src/schema/player-discord-links.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/schema.test.ts`

New table `player_discord_links` (#151) — the Discord identity bound to a panel player by the OAuth2 `identify` flow. It is the schema root for the rest of the Discord chain: DISCORD-5 (#152, role sync) and DISCORD-6 (#153, bot command gating) both resolve a player through it.

#### Added

- `player_discord_links(player_id, discord_user_id, discord_username, linked_at)`. `player_id` is the **primary key** and `REFERENCES players(id) ON DELETE CASCADE` — one link per player, and deleting a player takes the link with it.
- Unique constraint `player_discord_links_discord_user_id_unique` on `discord_user_id` — one player per Discord account. Together with the primary key this makes the relationship strictly 1:1 in both directions; `apps/api/src/routes/auth-discord.ts` translates the resulting unique violation (SQLSTATE 23505) into `409 already_linked_other` instead of pre-checking and racing.
- `discord_username` is a **snapshot** taken at link time. Discord display names change, and refreshing them requires a bot session (DISCORD-6), so nothing auto-updates this column.
- Panel-only data: no `public-*` route may select this table. `apps/api/test/security/discord-link-public-leak.test.ts` enforces that at runtime and statically.
### ISSUE-3 — issue_links (migration 0105)

**Files:** `packages/db/drizzle/0105_issue_links.sql`, `packages/db/src/schema/issue-links.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/schema.test.ts`

New table `issue_links` (#156) — the structural link between a tracker ticket and a panel entity (`player`, `server`, `moderation_action`, `media_file`). It is what lets the player card count the tickets that name a player, and what an auto-ticket created from a moderation action writes alongside the `issues` row.

#### Added

- `issue_links(id, issue_id, entity_type, entity_id, created_by, created_at)`. `issue_id` `REFERENCES issues(id) ON DELETE CASCADE`; `created_by` `REFERENCES players(id) ON DELETE SET NULL` (drives the detach ownership check).
- CHECK `issue_links_entity_type_check` — `entity_type IN ('player','server','moderation_action','media_file')`.
- `entity_id` is deliberately **not** a foreign key, exactly as in `media_links`: it is polymorphic across four target tables, so existence is verified by the API route layer before insert and a vanished target reads back as «Удалённый объект» instead of breaking the ticket.
- Unique index `issue_links_issue_entity_key` on `(issue_id, entity_type, entity_id)` — one link per ticket/target pair; a duplicate surfaces as `409 link_exists`.
- Indexes `issue_links_entity_idx` on `(entity_type, entity_id)` (reverse lookup for the player card) and `issue_links_issue_idx` on `(issue_id)`.

**Deletion strategy** (the acceptance criteria required one to be fixed in the migration): cascade on `issue_id`, no constraint on `entity_id`. "Нельзя удалить игрока при живых ссылках" is unreachable on a polymorphic column — `RESTRICT` needs a foreign key — and the panel exposes no hard player-delete route, so the read path degrading gracefully is the whole mitigation.
### LEAD-5 — server_daily_stats (migration 0101)

**Files:** `packages/db/drizzle/0101_server_daily_stats.sql`, `packages/db/src/schema/server-daily-stats.ts`, `packages/db/src/statistics/daily.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`, `packages/db/test/statistics-daily.test.ts`

New table `server_daily_stats` (#176) — the materialised per-server, per-UTC-day rollup behind `GET /api/v1/statistics`. One row per `(server_id, day)`: population (`avg_online`, `peak_online`, `avg_queue`, `online_seconds`), matches (`matches`, `modes` and `maps` as `{key: count}` jsonb), community (`new_players`, `chat_messages`, `teamkills`) and moderation (`punishments`, `avg_admins`, `peak_admins`). PK `(server_id, day)`, index `server_daily_stats_day_idx`, `server_daily_stats_nonneg_chk` on every counter, `ON DELETE CASCADE` from `servers`.

`recomputeServerDailyStats(sql, { fromDay, toDay, now })` is the table's **only** writer, invoked once per hour by `runPresenceDailyTick` (`apps/workers/presence-daily`) over the same yesterday+today window presence already recomputes. It deletes and rewrites the window in one transaction, so it is idempotent; days outside the window are never touched.

Data-source notes:

- Population comes from `player_sessions` alone. `player_daily_presence` stores only summed seconds and no instantaneous values, so peaks cannot be derived from it. `peak_online`/`peak_admins` are exact maxima from an interval sweep (+1 at each session start, −1 at each end, running sum), with ends ordered before starts at an identical instant so a same-second reconnect is not double-counted.
- Averages are time-weighted over the *elapsed* part of the day (`seconds / (min(day_end, now) − day_start)`), so the day in progress is not diluted by hours that have not happened yet.
- `matches` counts every round of the day; `modes` breaks all of them down; `maps` excludes `is_seed = true` and `game_mode = 'Skirmish'` (combat layers only).
- New players are attributed to the server of their earliest session on the day `players.first_seen_at` falls on. A player first seen without a session that day is counted nowhere, since no server can be attributed.
- `punishments` counts `moderation_actions` rows with a non-NULL `server_id`; coverage grows on its own as MOD-2 (#59) routes more enforcement paths into that table.

The migration is hand-written and its journal entry (`idx: 86`) appended by hand — `packages/db/drizzle/meta/` holds only `0008_snapshot.json`, so `drizzle-kit generate` cannot produce a correct diff for this repo.

---

## 2026-07-27
### VIDEO-3 — media_upload_tokens (migration 0096)

**Files:** `packages/db/drizzle/0096_media_upload_tokens.sql`, `packages/db/src/schema/media-upload-tokens.ts`, `packages/db/src/schema/media-files.ts`, `packages/db/src/schema/index.ts`

New table `media_upload_tokens` (#159) — one-time delegated-upload credentials that let an outside player upload a single file with no panel session, optionally pre-bound to the evidence target so the file files itself into the right case via `media_links`.

#### Added

- `media_upload_tokens(id, token_hash, issued_by_player_id, target_entity_type, target_entity_id, expires_at, used_at, max_size_bytes, created_at)`. `issued_by_player_id` `REFERENCES players(id) ON DELETE SET NULL` so the provenance of already-uploaded evidence survives the minter's deletion.
- `token_hash` stores **only** the hex sha-256 of the raw token, never the token itself — a database leak cannot be replayed into upload capability. `text` rather than `bytea`, matching the existing `player_api_tokens.token_hash` precedent. Unique index `media_upload_tokens_token_hash_key`.
- CHECK `media_upload_tokens_target_type_check` — `target_entity_type IS NULL OR target_entity_type IN ('player','moderation_action','match','issue')`, mirroring `media_links`.
- CHECK `media_upload_tokens_target_pair_check` — `(target_entity_type IS NULL) = (target_entity_id IS NULL)`, so a token is either fully pre-bound or not bound at all.
- Index `media_upload_tokens_expires_at_idx` for optional purge of expired rows.
- `media_files.upload_token_id uuid NULL REFERENCES media_upload_tokens(id) ON DELETE SET NULL` — both the provenance record and the anonymous/untrusted marker; such a row always has `uploader_player_id = NULL`.

#### Notes

- Single use is a database property. Redemption is the conditional `UPDATE media_upload_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`, which takes a row lock — of two concurrent uploads racing the same token exactly one can observe a returned row. `expires_at` is compared against the **database** clock, not the application's.

### VIDEO-2 — media_links (migration 0095)

**Files:** `packages/db/drizzle/0095_media_links.sql`, `packages/db/src/schema/media-links.ts`, `packages/db/src/schema/index.ts`, `packages/db/test/schema.test.ts`

New table `media_links` (#158) — the canonical polymorphic evidence store linking a `media_files` row to a `player`, `moderation_action`, `match`, or `issue`. It is the schema root for the media chain: #159 and #160 build on it, and #60 (MOD-3) attaches moderation-action evidence through it rather than a new `evidence[]` column.

#### Added

- `media_links(id, media_id, entity_type, entity_id, linked_by_player_id, created_at)`. `media_id` `REFERENCES media_files(id) ON DELETE CASCADE`; `linked_by_player_id` `REFERENCES players(id) ON DELETE SET NULL` (drives the attach/detach ownership check).
- CHECK `media_links_entity_type_check` — `entity_type IN ('player','moderation_action','match','issue')`.
- `entity_id` is deliberately **not** a foreign key: it is polymorphic across four target tables depending on `entity_type`, so existence is verified by the API route layer before insert, not by the database.
- Unique index `media_links_media_entity_key` on `(media_id, entity_type, entity_id)` — one link per media/target pair; a duplicate attach attempt surfaces as `409 already_linked`.
- Indexes `media_links_entity_idx` on `(entity_type, entity_id)` and `media_links_media_idx` on `(media_id)`.

## 2026-07-26

### DOSSIER-4 — materialize `player_stat_periods` combat columns (migration 0089)

**Files:** `packages/db/drizzle/0089_player_monthly_combat_source.sql`, `packages/db/src/leaderboard/aggregate.ts`, `packages/db/src/schema/player-stat-periods.ts`, `packages/db/sql/player-stat-periods.sql`

The combat columns (`kills`, `deaths`, `teamkills`, `revives`, `kd_ratio`) already shipped with the table; this entry records the aggregation behavior that now populates them from real data and the one new index (#191). No new table and no materialized view — the issue's maintainer spec supersedes the original `player_monthly_combat` + MV design.

#### Added

- Index `player_stat_periods_player_idx` on `(player_id, period_type, period_start DESC)` — the lookup path for the per-player monthly K/D trend (`GET /api/v1/players/:playerId/combat-summary`). `match_players` needed no new index: `match_players_player_match_idx` already covers the aggregation side.
- `backfillMonths(sql, months)` in `@squad/db` — one-shot recompute of the last N `month` periods, run at worker startup when `LEADERBOARD_BACKFILL_MONTHS > 0`.

#### Changed

- `recomputeLeaderboardPeriod` gains a `combat_agg` CTE over `match_players ⋈ matches` (same period filter as `matches_agg`) and writes `COALESCE(SUM(...), 0)` sums into the combat columns, replacing the previous hard-coded zeros. `kd_ratio` follows `computeKdRatio`: `deaths = 0 ⇒ kd = kills`, else `kills / deaths`. The all-servers rollup (`server_id IS NULL`) sums the per-server combat rows and recomputes `kd_ratio` from the summed totals.

## 2026-07-25

### LEAD-6 — materialize `player_stat_periods.seeding_seconds` (no migration)

**Files:** `packages/db/src/leaderboard/aggregate.ts`, `packages/db/src/economy/accrual.ts`

No schema change — the `seeding_seconds` column, its `player_stat_periods_metrics_chk` bound and the `player_stat_periods_seeding_idx` ranking index already shipped with the table. This entry records the aggregation/accrual behavior that now populates them (#177).

#### Changed

- `recomputeLeaderboardPeriod` now threads `SUM(player_daily_presence.seed_seconds)` through the `presence_agg` → `combined` → `per_server`/`rollup` CTEs and writes it into `player_stat_periods.seeding_seconds`, replacing the previous hard-coded `0`. The all-servers rollup (`server_id IS NULL`) sums the per-server seeding rows, matching the online/boost columns.
- `bonus_points` gains the seeding term: it is now `k_online × online + k_boost × boost + k_seed × seed`, with `k_seed` read from `economy_settings` (`COALESCE(k_seed, 3)`), consistent with the ECON-2 `earn_seed` ledger.
- `accrueDailyBonuses` now derives and persists `player_daily_presence.seed_seconds` **before** the `economy_enabled` short-circuit. Seed attribution (SEED-1 seeding-window intersection, with the legacy threshold sweep as fallback) is no longer gated on the monetization flag, so the seeding leaderboard is populated even with the economy off. Ledger writes (`bonus_transactions`, `players.bonus_balance`) stay gated on `economy_enabled`; the `AccrueDailyBonusesResult` shape is unchanged.

## 2026-05-02

### Migration 0016 — drop legacy "Viewer" role from production seed

- Spec §2.5 lists exactly six default roles (Owner + Admin + Moderator + QueuePriority + Cameraman + Intern). The Viewer row from migration 0009 is not in that set and is now removed.
- Tests that need a "narrow read-only" fixture call `ensureViewerFixture` from `apps/api/test/helpers/viewer-fixture.ts`; the integration harness ensures it once per build.
- Active player assignments to Viewer become `role_id = NULL` via the existing FK `ON DELETE SET NULL`.

## 2026-05-01

### Migration 0014 — role access flags + `role_squad_permissions` table

- `roles` gains three boolean columns: `panel_access`, `can_assign_roles`, `can_edit_roles`. Default `false`. CHECK constraint `roles_flag_dependency` enforces `panel_access OR (NOT can_assign_roles AND NOT can_edit_roles)` — i.e. role-management flags only meaningful when panel access is on.
- Color CHECK loosened to accept either a Tailwind palette name or a `#RRGGBB` hex code (back-compat with palette-named seed roles).
- New table `role_squad_permissions(role_id uuid → roles, squad_permission_key text)` with a CHECK enumerating the 21 Squad in-game permission keys.

### Migration 0015 — re-seed roles per Эпик 2 Phase 2 spec

- Owner row updated: `color='#FF0000'`, all three access flags `true`.
- Five new non-system roles created (or upserted by name): **Admin** `#CD5C5C` (panel_access), **Moderator** `#2E8B57` (panel_access), **QueuePriority** `#DAA520`, **Cameraman** `#8B008B`, **Intern** `#005EC2`. Each gets a distinct Squad-permission set per spec — see `docs/components/rbac/data-model.md`.
- Legacy "Senior Admin" row removed (no spec analogue, no consumers). Legacy "Viewer" row preserved for back-compat with the existing test fixture.
- Spec roles carry **no** rows in `role_permissions`; their panel-side permissions are derived in code by `apps/api/src/lib/rbac.ts` from the access flags.
## 2026-04-28

### Migration 0017 — `diagnostic_events` partitioned table

**File:** `packages/db/drizzle/0017_diagnostic_events.sql`

#### Added

- `diagnostic_events` parent table, range-partitioned by `ts`, with composite primary key `(id, ts)`.
- Columns: `id uuid`, `ts timestamptz`, `component text`, `severity text`, `kind text`, `server_id uuid` (FK → `servers.id` ON DELETE SET NULL), `actor_steam_id64 bigint`, `request_id text`, `message text`, `payload jsonb DEFAULT '{}'::jsonb`.
- Severity check constraint `diagnostic_events_severity_chk` restricting values to `('debug','info','warn','error','fatal')`.
- Indexes `diagnostic_events_ts_idx (ts DESC)`, `diagnostic_events_server_ts_idx (server_id, ts DESC)`, `diagnostic_events_kind_ts_idx (component, severity, ts DESC)`.
- 25 bootstrap partitions named `diagnostic_events_YYYYMMDD` covering yesterday + today + 23 future UTC days, created via a `DO` block using `format(... %I ... %L ... %L)`.

#### Migration notes

Forward-only and additive — no existing data is touched. Unlike `audit_log` and `config_versions`, this table is **mutable**: the partition pruner (`worker-event-partition`, future task) DROPs day-partitions older than 24h, and the wipe endpoint (future task) issues `TRUNCATE` against partitions. The `(id, ts)` composite PK is required by Postgres because `ts` is the partition key. The FK to `servers(id)` uses `ON DELETE SET NULL` so deleting a server does not cascade-delete its diagnostic trail; orphaned rows remain readable.

The Drizzle journal entry uses `idx: 14` (next sequential after `0013_servers_soft_delete`); the file numbering jumps to `0017` to leave room for in-flight migrations on parallel feature branches (`0014`–`0016`) and to match the file path expected by the diagnostic-bundle plan.

### Drizzle TS schema for `diagnostic_events`

**File:** `packages/db/src/schema/diagnostic-events.ts`

#### Added

- `diagnosticEvents` Drizzle table binding mirroring migration `0017_diagnostic_events.sql` column-for-column (uuid `id`, timestamptz `ts`, text `component`/`severity`/`kind`, uuid FK `server_id`, bigint `actor_steam_id64`, text `request_id`, text `message`, jsonb `payload` defaulting to `{}`).
- Composite primary key `(id, ts)` declared via `primaryKey({ columns: [table.id, table.ts] })` (same pattern as `events`).
- Indexes (`diagnostic_events_ts_idx`, `diagnostic_events_server_ts_idx`, `diagnostic_events_kind_ts_idx`) and check constraint (`diagnostic_events_severity_chk`) named identically to the migration so DDL diffing stays clean.
- `DiagnosticEventRow` and `NewDiagnosticEvent` type exports inferred from the schema.
- Re-export wired into `packages/db/src/schema/index.ts` between `config-versions.js` and `events.js`.

#### Migration notes

No DDL change — the SQL migration shipped in commit `d68fb21` already created the table. This entry only registers the Drizzle binding so application code can use the typed query builder. Drizzle indexes do not encode `DESC` ordering on individual columns; this is cosmetic and does not affect query plans.

---

## 2026-04-30

### Migration 0013 — soft-delete on `servers`

**File:** `packages/db/drizzle/0013_servers_soft_delete.sql`

#### Added

- `servers.deleted_at timestamptz NULL` — soft-delete marker.
- `servers.deleted_by_steam_id64 bigint NULL REFERENCES players(steam_id64) ON DELETE SET NULL` — actor that issued the deletion.
- `servers.deletion_backup_marker_id uuid NULL REFERENCES config_versions(id) ON DELETE SET NULL` — points at the first `config_versions` row of the deletion-time backup batch.
- `servers_deleted_at_idx` btree index on `deleted_at`.
- `servers_slug_active_key` partial unique index on `slug` WHERE `deleted_at IS NULL`.

#### Removed

- Full unique index `servers_slug_key` (replaced by the partial variant above).

#### Migration notes

Forward-only. Existing rows have `deleted_at = NULL`, so the partial unique index keeps the same constraint surface as the old full unique. After this migration a previously-used slug can be reclaimed once the original row is soft-deleted (`UPDATE servers SET deleted_at = now()`).

---

## 2025-04-30

### Migration 0012 — `host:manage` permission

**File:** `packages/db/drizzle/0012_host_manage_permission.sql`

#### Added

- Inserted `host:manage` permission key into `role_permissions` for the Owner and Senior Admin system roles (`ON CONFLICT DO NOTHING`).

#### Migration notes

This migration is additive and idempotent. Existing deployments that already had the column from a side-branch are unaffected.

---

### Migration 0011 — carry-forward `servers.is_canary`

**File:** `packages/db/drizzle/0011_servers_is_canary.sql`

#### Added

- `servers.is_canary boolean NOT NULL DEFAULT false` — marks canary/staging server instances.

#### Migration notes

`ALTER TABLE servers ADD COLUMN IF NOT EXISTS` — safe to run against a database that already has the column (no-op). The column was originally added on the `feat/rnsquadjs-migration` branch but not carried forward to `feat/panel-rbac`.

---

## 2025-04-29

### Migration 0010 — drop `servers.org_id`

**File:** `packages/db/drizzle/0010_drop_servers_org_id.sql`

#### Removed

- `servers.org_id` column (foreign key to `organizations` was already dropped with CASCADE in 0009).
- `servers_org_id_slug_key` UNIQUE constraint.
- `servers_org_status_idx` composite index on `(org_id, status)`.

#### Added

- `servers_slug_key` UNIQUE index on `servers.slug` (single-column, panel-global uniqueness).
- `servers_status_idx` plain index on `servers.status`.

#### Migration notes

Destructive; pre-launch only. Completes the multi-tenancy removal started in migration 0009.

---

### Migration 0009 — panel RBAC pivot

**File:** `packages/db/drizzle/0009_panel_rbac.sql`

#### Added

- `panel_meta` table with `CHECK (id = 1)` singleton constraint; seeded with one row (`first_owner_claimed = false`, `roles_seeded = false`).
- `players.role_id uuid REFERENCES roles(id) ON DELETE SET NULL` — single-role-per-player model.
- `players_role_id_idx` partial index on `role_id WHERE role_id IS NOT NULL`.
- `roles.color text NOT NULL DEFAULT 'neutral'` with `roles_color_palette` CHECK constraint (16 allowed values).
- `roles_name_key` UNIQUE index on `roles.name` (panel-global, replaces old per-org unique).
- 5 system roles inserted: Owner (`red`), Senior Admin (`amber`), Admin (`sky`), Moderator (`emerald`), Viewer (`neutral`).
- Full permission set for all 5 roles seeded into `role_permissions`.
- `panel_meta.roles_seeded` set to `true`.

#### Changed

- `roles` table: dropped `org_id`, `clearance_level`, and old `roles_org_name_key` index.

#### Removed

- `player_role_assignments` table (M:N, replaced by `players.role_id`).
- `role_server_scopes` table (per-server scope — never enforced).
- `organization_members` table.
- `organizations` table (CASCADE drops all FKs referencing it).
- `audit_log.org_id` column.

#### Migration notes

Destructive forward-only migration. Pre-launch — no production data to preserve. Rollback requires `DROP DATABASE + CREATE DATABASE + db:migrate`.

---

## 2025-04-28

### Migration 0008 — Steam-only auth

**File:** `packages/db/drizzle/0008_steam_only_auth.sql`

#### Added

- `sessions` table recreated keyed on `players.steam_id64` instead of `users.id`; adds `last_activity_at` column.
- `player_role_assignments` M:N table (steam_id64 ↔ role_id) — later removed in 0009.
- `organization_members` recreated with `steam_id64` anchor.
- `player_api_tokens` table (steam_id64-anchored bearer tokens).
- `audit_log` table recreated with `actor_kind` discriminant (`'steam'` | `'system'`), `actor_steam_id64`, `actor_token_id`, `actor_system_label`, `org_id` FK; hash-chain trigger re-created.
- `config_versions` table recreated with `author_steam_id64` and `author_label`; append-only trigger re-created with `WHEN (pg_trigger_depth() = 0)` on delete.

#### Removed

- `users`, `user_identities`, `user_api_tokens`, `user_role_assignments`, `organization_members` (user-anchored) tables with CASCADE.

#### Migration notes

Full identity-layer pivot. Destructive; pre-launch only.

---

## 2025-04-27

### Migration 0007 — RCON host nullable

**File:** `packages/db/drizzle/0007_rcon_host_null_default.sql`

#### Changed

- `server_credentials.rcon_host`: dropped `NOT NULL` constraint and default value.
- Updated existing rows where `rcon_host IN ('127.0.0.1', 'host.docker.internal')` → `NULL`.

#### Migration notes

Reverts migration 0006. NULL means "resolve against the caller's `RCON_HOST_DEFAULT` environment variable". This is needed because `worker-rcon` runs with `--network host` (reaches RCON at `127.0.0.1`) while `apps/api` runs in the Compose bridge network (reaches RCON via `host.docker.internal`).

---

## 2025-04-26

### Migration 0006 — RCON host → bridge network alias

**File:** `packages/db/drizzle/0006_rcon_host_bridge_network.sql`

#### Changed

- Updated `server_credentials.rcon_host` from `'127.0.0.1'` → `'host.docker.internal'` for all existing rows.

#### Migration notes

Superseded by 0007 which reverts this approach. Kept in history to document the decision trail.

---

## 2025-04-25

### Migration 0005 — backfill config role permissions

**File:** `packages/db/drizzle/0005_backfill_config_role_perms.sql`

#### Added (data)

- `server:config:write` and `server:config:history` permissions backfilled into the Owner and Senior Admin system roles.
- `server:config:history` backfilled into Admin and Viewer system roles.
- All inserts use `ON CONFLICT DO NOTHING`.

#### Migration notes

Fix for organizations created before migration 0003 introduced the config editor. Fresh installs are unaffected.

---

## 2025-04-24

### Migration 0004 — config versions cascade fix

**File:** `packages/db/drizzle/0004_config_versions_cascade.sql`

#### Fixed

- Replaced `config_versions_reject_delete` trigger without `WHEN` condition with a version that uses `WHEN (pg_trigger_depth() = 0)`. This allows FK cascade deletes from the `servers` parent table while still blocking direct client DELETEs.

#### Migration notes

Fixes `DELETE /api/v1/servers/:id` returning 500 with `config_versions is append-only`.

---

### Migration 0003 — config versions

**File:** `packages/db/drizzle/0003_config_versions.sql`

#### Added

- `config_versions` table with columns: `id`, `server_id`, `filename`, `content`, `sha256`, `parent_version_id`, `author_user_id`, `author_ip`, `message`, `created_at`.
- `config_versions_server_file_time_idx` composite index on `(server_id, filename, created_at DESC)`.
- `config_versions_sha256_idx` index on `sha256`.
- Append-only triggers `config_versions_reject_update` and `config_versions_reject_delete` (both unconditional at this stage; fixed in 0004).

---

## 2025-04-23

### Migration 0002 — server runtime column

**File:** `packages/db/drizzle/0002_server_runtime.sql`

#### Added

- `servers.runtime text NOT NULL DEFAULT 'container'` — pins all servers to Docker-container management.
- `servers.container_id text` — nullable Docker container short ID or name.
- `servers_runtime_enum` CHECK constraint (`runtime IN ('container')`).

---

## 2025-04-20

### Migration 0001 — seed system roles (no-op slot)

**File:** `packages/db/drizzle/0001_seed_system_roles.sql`

#### Notes

No-op (`SELECT 1`). Slot reserved for future use. System role seeding was deferred to the API setup wizard at this point in the project and later moved in-migration in 0009.

---

### Migration 0000 — initial schema

**File:** `packages/db/drizzle/0000_init.sql`

#### Added

- `pgcrypto` extension.
- `users`, `sessions` (user-anchored), `user_identities`, `user_api_tokens` — email/password identity layer (replaced in 0008).
- `organizations`, `roles` (org-scoped), `role_permissions`, `role_server_scopes`, `organization_members`, `user_role_assignments` — multi-tenant RBAC (replaced in 0009).
- `servers` (with `org_id` FK), `server_credentials`, `server_settings`.
- `players`, `player_name_history`, `player_ip_history`.
- `events` partitioned table with 6 bootstrap monthly partitions (`events_YYYY_MM`).
- `processed_events`.
- `audit_log` with hash-chain trigger (`audit_log_append`) and append-only guard triggers.
