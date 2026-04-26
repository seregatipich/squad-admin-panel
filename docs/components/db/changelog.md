# Changelog

All schema changes are recorded here in reverse chronological order, keyed by migration file. Dates are derived from the Drizzle journal (`packages/db/drizzle/meta/_journal.json`).

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
