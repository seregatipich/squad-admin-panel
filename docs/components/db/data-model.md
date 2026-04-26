# `db` — Data Model

All tables live in the `public` schema of a PostgreSQL 16+ database. The Drizzle schema source of truth is [`packages/db/src/schema/`](../../../packages/db/src/schema/); the canonical DDL is in the numbered SQL migrations under [`packages/db/drizzle/`](../../../packages/db/drizzle/).

---

## Table index

| Table | Source file | Purpose |
|---|---|---|
| [`audit_log`](#audit_log) | `audit-log.ts` | Append-only, hash-chained action log |
| [`config_versions`](#config_versions) | `config-versions.ts` | Append-only history of every cfg file edit |
| [`events`](#events) | `events.ts` | Monthly-partitioned Squad event feed |
| [`processed_events`](#processed_events) | `events.ts` | Event-consumer idempotency tracker |
| [`panel_meta`](#panel_meta) | `panel-meta.ts` | Singleton row for panel bootstrap state |
| [`player_api_tokens`](#player_api_tokens) | `player-api-tokens.ts` | Bearer API tokens issued to players |
| [`player_ip_history`](#player_ip_history) | `player-ip-history.ts` | Per-player IP observation dedup log |
| [`player_name_history`](#player_name_history) | `player-name-history.ts` | Per-player display-name dedup log |
| [`players`](#players) | `players.ts` | One row per SteamID64; universal identity anchor |
| [`role_permissions`](#role_permissions) | `role-permissions.ts` | M:N mapping of roles to permission keys |
| [`roles`](#roles) | `roles.ts` | RBAC role definitions |
| [`server_credentials`](#server_credentials) | `server-credentials.ts` | RCON password and license key (encrypted bytea) |
| [`server_settings`](#server_settings) | `server-settings.ts` | Per-server panel configuration |
| [`servers`](#servers) | `servers.ts` | One row per managed Squad server instance |
| [`sessions`](#sessions) | `sessions.ts` | Browser session tokens keyed on SteamID64 |

---

## `audit_log`

Immutable, hash-chained record of every state-mutating API action. The DB trigger `trg_audit_log_ins` (function `audit_log_append`) fills `prev_hash` and `row_hash` on every INSERT. UPDATE and DELETE raise `audit_log is append-only`.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `bigserial` | NO | auto | Primary key; must be `String(id)` in JSON (BigInt) |
| `created_at` | `timestamptz` | NO | `now()` | |
| `actor_kind` | `text` | NO | — | `'steam'` or `'system'` |
| `actor_steam_id64` | `bigint` | YES | NULL | Set when `actor_kind = 'steam'`; FK → `players.steam_id64` ON DELETE SET NULL |
| `actor_token_id` | `uuid` | YES | NULL | Set for API-token-authenticated requests; FK → `player_api_tokens.id` ON DELETE SET NULL |
| `actor_system_label` | `text` | YES | NULL | Set when `actor_kind = 'system'` (e.g. `'status-reconciler'`) |
| `actor_ip` | `inet` | YES | NULL | Source IP when available |
| `action_type` | `text` | NO | — | Verb-noun string, e.g. `'server.start'`, `'config.write'` |
| `target_type` | `text` | YES | NULL | Entity class, e.g. `'server'`, `'player'` |
| `target_id` | `text` | YES | NULL | Entity ID |
| `before_snapshot` | `jsonb` | YES | NULL | State before mutation (omitted for creates) |
| `after_snapshot` | `jsonb` | YES | NULL | State after mutation (omitted for deletes); `Rcon.cfg` contents never included |
| `context` | `jsonb` | NO | `{}` | Arbitrary extra fields |
| `status_code` | `integer` | YES | NULL | HTTP status code that the API returned |
| `duration_ms` | `integer` | YES | NULL | Handler wall-clock time |
| `prev_hash` | `bytea` | YES | NULL | SHA-256 of the previous row's `row_hash`; NULL on the first row |
| `row_hash` | `bytea` | NO | — | `sha256(prev_hash ∥ canonical_json(row))` written by trigger |

**Indexes**

| Name | Columns | Notes |
|---|---|---|
| `audit_log_created_at_idx` | `created_at` | Time-range queries |
| `audit_log_actor_steam_idx` | `(actor_steam_id64, created_at)` | Per-player activity |
| `audit_log_action_idx` | `(action_type, created_at)` | Filter by action class |
| `audit_log_target_idx` | `(target_type, target_id)` | "What happened to X?" |

**Constraints**

- `audit_log_actor_kind` CHECK: `(actor_kind = 'steam' AND actor_steam_id64 IS NOT NULL AND actor_system_label IS NULL) OR (actor_kind = 'system' AND actor_steam_id64 IS NULL AND actor_system_label IS NOT NULL)`

**Triggers**

| Trigger | Event | Function | Effect |
|---|---|---|---|
| `trg_audit_log_ins` | `BEFORE INSERT` | `audit_log_append()` | Acquires advisory xact lock `hashtextextended('audit_log', 0)`, reads last `row_hash`, sets `prev_hash`, computes and sets `row_hash` |
| `trg_audit_log_no_upd` | `BEFORE UPDATE` | `audit_log_deny()` | Raises `audit_log is append-only` |
| `trg_audit_log_no_del` | `BEFORE DELETE` | `audit_log_deny()` | Raises `audit_log is append-only` |

**Hash canonical form** (same as `scripts/verify-audit-chain.ts`):

```
sha256( prev_hash || utf8( action_type | target_type | target_id | context::text | created_at::text ) )
```

**Example row:**

```json
{
  "id": "1",
  "created_at": "2026-04-25T10:00:00.000Z",
  "actor_kind": "steam",
  "actor_steam_id64": "76561198012345678",
  "actor_token_id": null,
  "actor_system_label": null,
  "actor_ip": "10.0.0.5",
  "action_type": "server.start",
  "target_type": "server",
  "target_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "before_snapshot": null,
  "after_snapshot": { "status": "starting" },
  "context": {},
  "status_code": 200,
  "duration_ms": 12,
  "prev_hash": "<hex>",
  "row_hash": "<hex>"
}
```

---

## `config_versions`

Append-only history of every server configuration file edit. Every PUT on `/api/v1/servers/:id/configs/:name` inserts one row. Restore creates a new row with old content — never a destructive update. UPDATE and DELETE raise `config_versions is append-only` (trigger allows FK cascade deletes from `servers` via `WHEN (pg_trigger_depth() = 0)`).

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | Primary key |
| `server_id` | `uuid` | NO | — | FK → `servers.id` ON DELETE CASCADE |
| `filename` | `text` | NO | — | e.g. `'Server.cfg'` |
| `content` | `text` | NO | — | Full file text |
| `sha256` | `bytea` | NO | — | SHA-256 of `content` |
| `parent_version_id` | `uuid` | YES | NULL | Points to the immediately preceding version for this `(server_id, filename)` pair |
| `author_steam_id64` | `bigint` | YES | NULL | FK → `players.steam_id64` ON DELETE SET NULL; NULL for system-generated versions |
| `author_label` | `text` | YES | NULL | `'system'` when `author_steam_id64` is NULL |
| `author_ip` | `inet` | YES | NULL | |
| `message` | `text` | YES | NULL | Optional commit message from the editor |
| `created_at` | `timestamptz` | NO | `now()` | |

**Indexes**

| Name | Columns | Notes |
|---|---|---|
| `config_versions_server_file_time_idx` | `(server_id, filename, created_at)` | Paginated history per file |
| `config_versions_sha256_idx` | `sha256` | Dedup / no-op short-circuit |

**Constraints**

- `config_versions_author_presence` CHECK: `author_steam_id64 IS NOT NULL OR author_label IS NOT NULL`

**Triggers**

| Trigger | Event | Condition | Effect |
|---|---|---|---|
| `trg_config_versions_no_upd` | `BEFORE UPDATE` | always | Raises `config_versions is append-only` |
| `trg_config_versions_no_del` | `BEFORE DELETE` | `WHEN (pg_trigger_depth() = 0)` | Raises `config_versions is append-only`; depth > 0 allows FK cascade from `servers` |

**Example row:**

```json
{
  "id": "d3f1a2b3-0000-0000-0000-000000000001",
  "server_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "filename": "Server.cfg",
  "content": "ServerName=My Squad Server\nMaxPlayers=80\n",
  "sha256": "<32 bytes hex>",
  "parent_version_id": null,
  "author_steam_id64": null,
  "author_label": "system",
  "author_ip": null,
  "message": "initial install — SteamCMD depot default",
  "created_at": "2026-04-25T08:00:00.000Z"
}
```

---

## `events`

Monthly-partitioned table for Squad event envelopes produced by `worker-rcon` and `worker-log-ingest`. The partition key is `occurred_at`. Partitions are named `events_YYYY_MM`. Bootstrap creates 6 months of forward partitions; `worker-event-partition` creates new ones monthly.

**Primary key**: `(event_id, occurred_at)` — composite because of partitioning.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `event_id` | `uuid` | NO | — | UUIDv7 from `EventEnvelope` |
| `server_id` | `uuid` | YES | NULL | FK → `servers.id` ON DELETE CASCADE (referencing a partition-parent is not enforced by PG) |
| `occurred_at` | `timestamptz` | NO | — | Partition key |
| `kind` | `text` | NO | — | Discriminant from `EventEnvelope`, e.g. `'player.connected'` |
| `version` | `integer` | NO | `1` | Schema version of the event payload |
| `actor_kind` | `text` | YES | NULL | `'player'`, `'rcon'`, or NULL |
| `actor_id` | `text` | YES | NULL | SteamID64 string or RCON command label |
| `correlation_id` | `uuid` | YES | NULL | Groups related events |
| `payload` | `jsonb` | NO | — | Full discriminated-union payload from `EventEnvelope` |

**Indexes** (on parent; inherited by partitions)

| Name | Columns | Partial WHERE |
|---|---|---|
| `events_server_occurred_idx` | `(server_id, occurred_at DESC)` | — |
| `events_kind_occurred_idx` | `(kind, occurred_at DESC)` | `kind IN ('player.connected','player.disconnected','rcon.players_polled')` |

**Example row:**

```json
{
  "event_id": "018f1a2b-3c4d-7000-8000-000000000001",
  "server_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "occurred_at": "2026-04-25T12:00:00.000Z",
  "kind": "player.connected",
  "version": 1,
  "actor_kind": "player",
  "actor_id": "76561198012345678",
  "correlation_id": null,
  "payload": { "steamId64": "76561198012345678", "name": "SquadPlayer" }
}
```

---

## `processed_events`

Idempotency table for event consumers. Before a worker processes an event it inserts `event_id` here. ON CONFLICT means the event was already handled by this consumer group.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `event_id` | `uuid` | NO | — | Primary key |
| `group_name` | `text` | NO | — | Consumer group name |
| `processed_at` | `timestamptz` | NO | `now()` | |

---

## `panel_meta`

Singleton row (enforced by `CHECK (id = 1)`). Tracks bootstrap state so the first-owner claim and role seed are idempotent across process restarts.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `smallint` | NO | `1` | Primary key; CHECK enforces value = 1 |
| `first_owner_claimed` | `boolean` | NO | `false` | Set to `true` after the first Steam login claims the Owner role |
| `roles_seeded` | `boolean` | NO | `false` | Set to `true` by migration `0009_panel_rbac.sql` after inserting the 5 system roles |
| `created_at` | `timestamptz` | NO | `now()` | |

**Constraints**

- `panel_meta_singleton` CHECK: `id = 1`

**Example row:**

```json
{
  "id": 1,
  "first_owner_claimed": true,
  "roles_seeded": true,
  "created_at": "2026-04-20T09:00:00.000Z"
}
```

---

## `player_api_tokens`

Programmatic bearer tokens for automation scripts and external integrations. The raw token is never stored; only its SHA-256 `token_hash` is persisted.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NO | — | Primary key |
| `steam_id64` | `bigint` | NO | — | FK → `players.steam_id64` ON DELETE CASCADE |
| `name` | `text` | NO | — | Human label for the token |
| `token_hash` | `text` | NO | — | SHA-256 hex of the raw token |
| `scopes` | `text[]` | NO | `{}` | Permission keys granted to this token |
| `last_used_at` | `timestamptz` | YES | NULL | Updated on each successful authentication |
| `created_at` | `timestamptz` | NO | `now()` | |
| `revoked_at` | `timestamptz` | YES | NULL | Non-NULL = token is revoked |

**Indexes**

| Name | Columns |
|---|---|
| `player_api_tokens_steam_id64_idx` | `steam_id64` |

**Example row:**

```json
{
  "id": "b7e2f1a0-0000-0000-0000-000000000001",
  "steam_id64": "76561198012345678",
  "name": "CI deploy token",
  "token_hash": "a3f8...c2d1",
  "scopes": ["server:view", "server:start"],
  "last_used_at": "2026-04-25T09:00:00.000Z",
  "created_at": "2026-04-10T00:00:00.000Z",
  "revoked_at": null
}
```

---

## `player_ip_history`

Deduplicated log of observed `(steam_id64, ip)` pairs. When a player connects with an IP already in the table, `observation_count` and `last_seen_at` are upserted instead of inserting a new row.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `bigserial` | NO | auto | Primary key |
| `steam_id64` | `bigint` | NO | — | FK → `players.steam_id64` ON DELETE CASCADE |
| `ip` | `inet` | NO | — | |
| `first_seen_at` | `timestamptz` | NO | `now()` | |
| `last_seen_at` | `timestamptz` | NO | `now()` | |
| `observation_count` | `integer` | NO | `1` | Incremented on upsert |

**Indexes**

| Name | Columns | Type |
|---|---|---|
| `player_ip_history_steam_ip_key` | `(steam_id64, ip)` | UNIQUE |
| `player_ip_history_ip_idx` | `ip` | plain |

---

## `player_name_history`

Deduplicated log of observed `(steam_id64, name_normalized)` pairs. Normalization (lowercase + trim) prevents near-duplicates from inflating the table.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `bigserial` | NO | auto | Primary key |
| `steam_id64` | `bigint` | NO | — | FK → `players.steam_id64` ON DELETE CASCADE |
| `name` | `text` | NO | — | Display name as observed |
| `name_normalized` | `text` | NO | — | `lower(trim(name))` |
| `first_seen_at` | `timestamptz` | NO | `now()` | |
| `last_seen_at` | `timestamptz` | NO | `now()` | |
| `observation_count` | `integer` | NO | `1` | Incremented on upsert |

**Indexes**

| Name | Columns | Type |
|---|---|---|
| `player_name_history_steam_name_key` | `(steam_id64, name_normalized)` | UNIQUE |
| `player_name_history_name_normalized_idx` | `name_normalized` | plain |
| `player_name_history_last_seen_at_idx` | `last_seen_at` | plain |

---

## `players`

One row per Steam account that has ever been seen on any managed server. The `steam_id64` bigint is the universal identity anchor for sessions, tokens, role assignments, and audit log entries.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `steam_id64` | `bigint` | NO | — | Primary key |
| `canonical_name` | `text` | NO | — | Most recently observed display name |
| `canonical_name_normalized` | `text` | NO | — | `lower(trim(canonical_name))` |
| `eos_id` | `text` | YES | NULL | Epic Online Services ID; unique where non-NULL |
| `battle_eye_guid` | `text` | YES | NULL | BattleEye GUID |
| `last_known_ip` | `inet` | YES | NULL | Last observed connect IP |
| `role_id` | `uuid` | YES | NULL | FK → `roles.id` ON DELETE SET NULL; NULL = no panel access |
| `first_seen_at` | `timestamptz` | NO | `now()` | |
| `last_seen_at` | `timestamptz` | NO | `now()` | |
| `total_time_played_seconds` | `bigint` | NO | `0` | Cumulative playtime across all servers |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | |

**Indexes**

| Name | Columns | Partial WHERE |
|---|---|---|
| `players_eos_id_unique_idx` | `eos_id` | `eos_id IS NOT NULL` |
| `players_canonical_name_normalized_idx` | `canonical_name_normalized` | — |
| `players_last_seen_at_idx` | `last_seen_at` | — |
| `players_role_id_idx` | `role_id` | `role_id IS NOT NULL` |

**Example row:**

```json
{
  "steam_id64": "76561198012345678",
  "canonical_name": "SquadPlayer",
  "canonical_name_normalized": "squadplayer",
  "eos_id": "0002a1b2c3d4e5f60000000000000001",
  "battle_eye_guid": null,
  "last_known_ip": "203.0.113.42",
  "role_id": "f7e0a1b2-0000-0000-0000-000000000001",
  "first_seen_at": "2026-01-01T12:00:00.000Z",
  "last_seen_at": "2026-04-25T11:00:00.000Z",
  "total_time_played_seconds": 86400,
  "created_at": "2026-01-01T12:00:00.000Z",
  "updated_at": "2026-04-25T11:00:00.000Z"
}
```

---

## `role_permissions`

M:N join table mapping roles to permission key strings. A player with `players.role_id = X` is granted every `permission_key` in the set `{ rp.permission_key | rp.role_id = X }`.

**Columns**

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `role_id` | `uuid` | NO | FK → `roles.id` ON DELETE CASCADE |
| `permission_key` | `text` | NO | e.g. `'server:start'`, `'audit:view'` |

**Primary key**: `(role_id, permission_key)`

**Permission key catalogue** (as seeded by migration `0009_panel_rbac.sql`):

`server:view`, `server:install`, `server:start`, `server:stop`, `server:force_stop`, `server:restart`, `server:delete`, `server:edit_settings`, `server:update`, `config:view`, `config:edit`, `config:rollback`, `player:view`, `player:view_ips`, `player:view_notes`, `player:edit_notes`, `player:set_flags`, `mod:kick`, `mod:warn`, `mod:ban_temp`, `mod:ban_perm`, `mod:unban`, `admin_group:view`, `admin_group:edit`, `whitelist:view`, `whitelist:edit`, `host:view`, `host:metrics`, `host:manage` (added migration `0012`), `audit:view`, `audit:export`, `events:view`, `user:view`, `user:manage_roles`, `role:view`, `role:create`, `role:edit`, `role:delete`, `backup:view`, `backup:trigger`, `backup:restore`, `api_token:create`, `api_token:revoke`, `discord:link`, `trigger:view`, `trigger:edit`, `scheduler:view`, `scheduler:edit`

---

## `roles`

RBAC role definitions. Five system roles are seeded by migration `0009_panel_rbac.sql`: Owner, Senior Admin, Admin, Moderator, Viewer. Custom roles can be created by users with `role:create`. The Owner role is the only one with `is_system_role = true` that cannot be deleted.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NO | — | Primary key |
| `name` | `text` | NO | — | Unique across panel |
| `description` | `text` | YES | NULL | |
| `color` | `text` | NO | `'neutral'` | One of 16 palette values (see CHECK) |
| `is_system_role` | `boolean` | NO | `false` | System roles cannot be deleted via API |
| `created_at` | `timestamptz` | NO | `now()` | |

**Indexes**

| Name | Columns | Type |
|---|---|---|
| `roles_name_key` | `name` | UNIQUE |

**Constraints**

- `roles_color_palette` CHECK: `color IN ('red','rose','pink','fuchsia','purple','violet','indigo','blue','sky','cyan','teal','emerald','green','lime','amber','neutral')`

**Example row:**

```json
{
  "id": "f7e0a1b2-0000-0000-0000-000000000001",
  "name": "Owner",
  "description": "Полный доступ. Системная роль, не редактируется.",
  "color": "red",
  "is_system_role": true,
  "created_at": "2026-04-20T09:00:00.000Z"
}
```

---

## `server_credentials`

One row per server; primary key mirrors `servers.id`. Stores the RCON password and optional Squad license key as encrypted `bytea` values.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `server_id` | `uuid` | NO | — | Primary key + FK → `servers.id` ON DELETE CASCADE |
| `rcon_host` | `text` | YES | NULL | NULL = callers use `RCON_HOST_DEFAULT` env var; non-NULL pins a specific hostname |
| `rcon_port` | `integer` | NO | — | |
| `rcon_password_encrypted` | `bytea` | NO | — | AES-256-GCM encrypted value |
| `license_key_encrypted` | `bytea` | YES | NULL | AES-256-GCM encrypted; NULL if no license |
| `key_version` | `integer` | NO | `1` | Encryption key rotation counter |

---

## `server_settings`

One row per server; primary key mirrors `servers.id`. Stores Docker-level and Squad-runtime parameters.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `server_id` | `uuid` | NO | — | Primary key + FK → `servers.id` ON DELETE CASCADE |
| `install_path` | `text` | NO | — | Host path under `/var/lib/squad-panel/configs/{uuid}` |
| `game_port` | `integer` | NO | — | Squad game port (UDP) |
| `query_port` | `integer` | NO | — | Steam query port (UDP) |
| `beacon_port` | `integer` | NO | — | Steam beacon port (UDP) |
| `rcon_port` | `integer` | NO | — | Valve RCON port (TCP) |
| `max_players` | `integer` | NO | `100` | |
| `tickrate` | `integer` | NO | `50` | |
| `multihome` | `inet` | YES | NULL | Bind to a specific NIC |
| `extra_args` | `text` | NO | `''` | Appended to the Squad launch command |
| `launch_args_override` | `text` | YES | NULL | Completely replaces the default arg set when non-NULL |
| `cpu_affinity` | `text` | YES | NULL | `taskset` mask |
| `cpu_weight` | `integer` | YES | NULL | cgroup `CPUWeight` (100–10000) |
| `niceness` | `integer` | YES | NULL | Process nice value (-20 to 19) |
| `memory_high_mb` | `integer` | YES | NULL | cgroup `MemoryHigh` in MiB |
| `memory_max_mb` | `integer` | YES | NULL | cgroup `MemoryMax` in MiB |
| `io_weight` | `integer` | YES | NULL | cgroup `IOWeight` (1–10000) |

---

## `servers`

One row per managed Squad server instance. Multi-tenancy columns (`org_id`) were removed in migrations 0009–0010.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NO | — | Primary key |
| `display_name` | `text` | NO | — | Human name shown in the UI |
| `slug` | `text` | NO | — | URL-safe unique identifier |
| `description` | `text` | YES | NULL | |
| `status` | `text` | NO | `'pending'` | See status enum below |
| `runtime` | `text` | NO | `'container'` | Only `'container'` is allowed |
| `container_id` | `text` | YES | NULL | Docker container short ID or name |
| `tags` | `text[]` | NO | `{}` | Free-form labels |
| `timezone` | `text` | NO | `'UTC'` | IANA timezone name |
| `is_canary` | `boolean` | NO | `false` | Marks canary/staging server instances |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | |

**Status enum** (enforced by CHECK `servers_status_enum`):

`pending` → `installing` → `ready` → `starting` → `running` → `stopping` → `stopped` | `failed`

**Indexes**

| Name | Columns | Type |
|---|---|---|
| `servers_slug_key` | `slug` | UNIQUE |
| `servers_status_idx` | `status` | plain |

**Constraints**

- `servers_status_enum` CHECK: `status IN ('pending','installing','ready','starting','running','stopping','stopped','failed')`
- `servers_runtime_enum` CHECK: `runtime IN ('container')`

---

## `sessions`

Browser session tokens. The `id` column is an opaque string (UUID or prefixed random value) set as the `__Host-sid` cookie. Sessions are looked up on every authenticated request.

**Columns**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | `text` | NO | — | Primary key; value stored in `__Host-sid` cookie |
| `steam_id64` | `bigint` | NO | — | FK → `players.steam_id64` ON DELETE CASCADE |
| `expires_at` | `timestamptz` | NO | — | Absolute expiry; checked on every request |
| `last_activity_at` | `timestamptz` | NO | `now()` | Sliding-window updated on activity |
| `ip` | `inet` | YES | NULL | IP at session creation |
| `user_agent` | `text` | YES | NULL | Browser User-Agent header |
| `created_at` | `timestamptz` | NO | `now()` | |

**Indexes**

| Name | Columns |
|---|---|
| `sessions_steam_id64_idx` | `steam_id64` |
| `sessions_expires_at_idx` | `expires_at` |
| `sessions_last_activity_idx` | `last_activity_at` |

---

## Migration history

Applied in order by `pnpm db:migrate`. Journal: [`packages/db/drizzle/meta/_journal.json`](../../../packages/db/drizzle/meta/_journal.json).

| # | Tag | Date (UTC epoch) | Description |
|---|---|---|---|
| 0000 | `0000_init` | 2026-04-20 | Full initial schema: users/sessions/orgs/RBAC/servers/players/events/audit_log with hash-chain triggers |
| 0001 | `0001_seed_system_roles` | 2026-04-20 | No-op slot; actual seeding deferred to API setup wizard (was per-org at the time) |
| 0002 | `0002_server_runtime` | 2026-04-24 | `ALTER TABLE servers ADD COLUMN runtime text NOT NULL DEFAULT 'container'` + `container_id`; adds `servers_runtime_enum` CHECK |
| 0003 | `0003_config_versions` | 2026-04-24 | Creates `config_versions` table with append-only triggers |
| 0004 | `0004_config_versions_cascade` | 2026-04-25 | Fixes `DELETE /servers/:id` bug — recreation of `config_versions_reject_delete` trigger with `WHEN (pg_trigger_depth() = 0)` |
| 0005 | `0005_backfill_config_role_perms` | 2026-04-25 | Backfills `server:config:write` and `server:config:history` permissions onto Owner/Senior Admin/Admin/Viewer system roles |
| 0006 | `0006_rcon_host_bridge_network` | 2026-04-26 | Migrates `rcon_host` values from `127.0.0.1` → `host.docker.internal` for compose bridge network access |
| 0007 | `0007_rcon_host_null_default` | 2026-04-27 | Reverts 0006: makes `rcon_host` nullable, sets existing rows to NULL so each caller uses its own `RCON_HOST_DEFAULT` env |
| 0008 | `0008_steam_only_auth` | 2026-04-28 | Drops `users`/`user_identities`/`user_api_tokens`/`user_role_assignments`/`organization_members`; recreates `sessions`, `player_api_tokens`, `audit_log`, `config_versions` anchored on `players.steam_id64` |
| 0009 | `0009_panel_rbac` | 2026-04-29 | Creates `panel_meta`, drops multi-tenancy (`organizations`, `player_role_assignments`, `role_server_scopes`), reshapes `roles` (drops `org_id`/`clearance_level`, adds `color`), adds `players.role_id`, seeds 5 system roles with full permission sets |
| 0010 | `0010_drop_servers_org_id` | 2026-04-29 | Drops `servers.org_id` column and old composite indexes; creates `servers_slug_key` and `servers_status_idx` |
| 0011 | `0011_servers_is_canary` | 2026-04-29 | Carry-forward: `ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_canary boolean NOT NULL DEFAULT false` |
| 0012 | `0012_host_manage_permission` | 2026-04-29 | Grants `host:manage` permission to Owner and Senior Admin system roles |
