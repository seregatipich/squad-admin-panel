# Changelog

All schema changes are recorded here in reverse chronological order, keyed by migration file. Dates are derived from the Drizzle journal (`packages/db/drizzle/meta/_journal.json`).

---

## 2026-07-27

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
