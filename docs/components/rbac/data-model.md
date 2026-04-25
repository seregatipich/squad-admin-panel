# `rbac` — data model

Migrations that built this model: `0009_panel_rbac.sql`, `0010_drop_org_id.sql`, `0011_carry_forward_is_canary.sql`, `0012_host_manage_permission.sql`.

---

## `roles`

Defined in [`packages/db/src/schema/roles.ts`](../../../packages/db/src/schema/roles.ts).

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY DEFAULT `gen_random_uuid()` | |
| `name` | `text` | NOT NULL, UNIQUE (`roles_name_key`) | Global unique name. |
| `color` | `text` | NOT NULL DEFAULT `'neutral'`, CHECK `roles_color_palette` | One of the 16 Tailwind slugs from `ROLE_COLORS`. |
| `is_system_role` | `boolean` | NOT NULL DEFAULT `false` | `true` only for the Owner role. API blocks PUT/DELETE on system roles. |
| `description` | `text` | nullable | Optional operator notes. |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

Removed columns (dropped in 0009): `org_id`, `clearance_level`.

---

## `role_permissions`

Defined in [`packages/db/src/schema/role-permissions.ts`](../../../packages/db/src/schema/role-permissions.ts).

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY | |
| `role_id` | `uuid` | NOT NULL, FK → `roles(id)` ON DELETE CASCADE | |
| `permission_key` | `text` | NOT NULL | Must match a `PermissionKey` from `PERMISSIONS`. No DB CHECK — enforced at the application layer. |

Composite UNIQUE on `(role_id, permission_key)`.

The permission keys themselves are defined in `packages/shared-config/src/permissions.ts` as `PERMISSIONS: readonly PermissionDef[]`. Adding a new permission requires only a one-line append there — no migration, no row changes needed.

---

## `players.role_id`

Defined in [`packages/db/src/schema/players.ts`](../../../packages/db/src/schema/players.ts).

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `role_id` | `uuid` | nullable, FK → `roles(id)` ON DELETE SET NULL | The player's single panel role. `NULL` ⇒ no panel access. |

Index: `players_role_id_idx` (partial, WHERE `role_id IS NOT NULL`).

`ON DELETE SET NULL` means deleting a role strips access from all its carriers without deleting the player rows. The permission cache for affected players is explicitly invalidated before the DELETE.

The `player_role_assignments` M:N table was dropped in migration 0009. `role_server_scopes` was also dropped — all permissions are global.

---

## `panel_meta`

Defined in [`packages/db/src/schema/panel-meta.ts`](../../../packages/db/src/schema/panel-meta.ts). Singleton table.

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `id` | `smallint` | PRIMARY KEY DEFAULT 1, CHECK `id = 1` | Enforces the singleton invariant. |
| `first_owner_claimed` | `boolean` | NOT NULL DEFAULT `false` | Set to `true` in the same transaction that assigns the Owner role on the first Steam login. After this flag is set, the first-login trick is permanently disabled. |
| `roles_seeded` | `boolean` | NOT NULL DEFAULT `false` | Set to `true` by migration 0009 after the five system role INSERTs. No application code writes this. |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

There is always exactly one row: `SELECT * FROM panel_meta WHERE id = 1`.

---

## Dropped tables

Migration 0009 dropped (with CASCADE):

- `player_role_assignments` — M:N player ↔ role, replaced by `players.role_id`.
- `role_server_scopes` — per-server permission scoping, unused and dropped.
- `organizations` — multi-tenancy, removed.
- `organization_members` — multi-tenancy, removed.
- `audit_log.org_id` column — dropped with the organisations removal.

---

## Seeded roles

Migration 0009 INSERTs five roles and their `role_permissions` rows. The Owner role has `is_system_role = true`; the other four do not.

| Role | Color | System | Default permissions |
|---|---|---|---|
| Owner | `red` | yes | All keys including `unimplemented` |
| Senior Admin | `amber` | no | All except `server:delete`, `role:delete`, `backup:restore` |
| Admin | `sky` | no | Server ops, config ops, player/mod ops, audit/events, api tokens |
| Moderator | `emerald` | no | `server:view`, `player:view`, `mod:kick/warn/ban_temp/unban`, `events:view` |
| Viewer | `neutral` | no | All `*:view` keys |

`player_api_tokens` rows are truncated in migration 0009 (pre-launch; no real tokens existed at the time of the migration).

---

## Relationships

```
roles(id) ──< role_permissions(role_id)
roles(id) ──< players(role_id)    [ON DELETE SET NULL]

panel_meta                        [singleton, one row always present]
```

---

## Validation rules

- `roles.color` is constrained by the DB CHECK `roles_color_palette` to the exact 16 slug values in `ROLE_COLORS`. The unit test in `packages/shared-config/test/role-colors.test.ts` asserts the TS constant and the SQL constraint are in sync.
- `role_permissions.permission_key` is not CHECK-constrained in the DB. The application validates against `isPermissionKey()` from `@squad/shared-config` on every write.
- `players.role_id = NULL` is the sole access-control gate. No parallel state in session claims, JWT, or Redis.
