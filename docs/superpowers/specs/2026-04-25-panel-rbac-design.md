# Panel RBAC — Design

**Status**: design approved 2026-04-25, implementation pending
**Scope**: Epic 2 — access permissions for the web panel itself
**Out of scope**: Squad in-game admin groups (Epic 3 — separate; this work only adds stub permissions for it)

---

## 1. Goal and invariants

The panel uses a permission-key model. A role = a name + a color + the `is_system_role` flag + a set of permission keys. A user has one role or none. A role is global. No hierarchy and no clearance — whoever can do more simply has more checkboxes.

**Architectural invariant**: `players.role_id IS NULL` ⇔ "no access to the panel". This is the single source of truth; there is no parallel state in session claims, JWT or Redis.

**Owner**: the only protected role. It cannot be edited, deleted or renamed. It is protected by two invariants:
1. In the API: PUT/DELETE for the role with `is_system_role = true AND name = 'Owner'` return 400.
2. In the API: on PUT `/players/:id/role` with an "Owner → non-Owner" transition — if it would leave the system without an Owner, the response is 409 `cannot_remove_last_owner`.

---

## 2. Decisions and trade-offs

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | Single-role: a new column `players.role_id uuid NULL`, drop the M:N table `player_role_assignments` | Keep M:N with a UNIQUE index on steam\_id64 | Pre-launch stage. An M:N that "simulates 1:1" is tech debt from day one. The spec is written around a single role as an invariant. |
| 2 | No `clearance_level`. `user:manage_roles` grants the right to assign any role | A separate `role:assign_owner` for escalation | The spec, literally: "no clearance, ranking or hierarchy". Escalation is the operator's responsibility (grant `user:manage_roles` only to trusted people). |
| 3 | Drop `role_server_scopes` entirely | Keep it as a dormant schema | It was never enforced. Pre-launch — a migration can easily bring it back if needed. |
| 4 | Drop `organizations` + `organization_members`. A singleton `panel_meta` appears | Keep the org scaffolding | Multi-tenancy is not used and is not planned in the foreseeable future. The user explicitly approved the removal. |
| 5 | The permission registry is an array of objects `{key, category, label, dangerous?, unimplemented?}` | A flat array + a side map with metadata; a DB permissions table | A single source of truth, types are derived, and adding a permission stays a one-line append with no migration. |
| 6 | The full permission registry up front — including P2 `unimplemented` stubs | Only keys for the existing code | The spec describes the mature state. The editor UI looks right from the start; new routes use `config: { permissions: [...] }` with no registry edit. |
| 7 | 5 system roles. `is_system_role = true` only for Owner | All 5 are system / no flag at all | Owner is the only untouchable role. Senior Admin / Admin / Moderator / Viewer are presets, which the operator is free to edit and delete. |
| 8 | Two places to manage a role: `/users` (new) + a simplified PanelAccessSection on `/players/:id` | Only one of the two | The spec requires `/users` with a list of those who hold a role; the in-place workflow on `/players/:id` already exists and is convenient ("I'm looking at a problem player — I grant a role"). |
| 9 | The setup wizard goes away. First-login Owner trick on the Steam callback | Keep the env-check page | The wizard loses its job after the orgs are dropped; the first-login trick is exactly as in the spec. |
| 10 | Full before/after snapshots in the audit | Diff only; no snapshots | Matches the approach for config\_versions; reconstructing the state is simple. |
| 11 | Targeted invalidation of the in-memory cache + a 30s TTL | Redis pub/sub; dropping the cache | A multi-instance API is not needed right now. Targeted invalidation takes effect immediately; the TTL is a safety net. |
| 12 | TRUNCATE `player_api_tokens` in the migration | Map permission renames in scopes; do nothing | Pre-launch, there are no real tokens. |
| 13 | A palette of 16 fixed colors (slug names matching Tailwind), color = a marker dot | A free-form hex; a pill with the name | UX — a pill with the name everywhere is noisy; a dot is enough to show "a difference in colors". The 16 colors are guaranteed to be readable on a dark theme without a runtime contrast check. |

---

## 3. Data model

### New table `panel_meta`

A singleton — one row, protected by a CHECK.

```sql
CREATE TABLE panel_meta (
  id                    smallint     PRIMARY KEY DEFAULT 1,
  first_owner_claimed   boolean      NOT NULL DEFAULT false,
  roles_seeded          boolean      NOT NULL DEFAULT false,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT panel_meta_singleton CHECK (id = 1)
);
INSERT INTO panel_meta (id) VALUES (1);
```

`first_owner_claimed` is set to `true` in the same transaction as `players.role_id = <Owner>` on the first successful Steam login.
`roles_seeded` is set to `true` by the same migration, after the INSERTs of the system roles. There is no repeat seeder in the API.

### Changes to `players`

```sql
ALTER TABLE players
  ADD COLUMN role_id uuid REFERENCES roles(id) ON DELETE SET NULL;
CREATE INDEX players_role_id_idx ON players(role_id) WHERE role_id IS NOT NULL;
```

NULL — no access to the panel → redirect to `/no-access`. `ON DELETE SET NULL` — when a role is deleted, all its holders lose access, but the `players` record and its history are preserved.

### Changes to `roles`

```sql
ALTER TABLE roles DROP COLUMN org_id;
ALTER TABLE roles DROP COLUMN clearance_level;
ALTER TABLE roles DROP CONSTRAINT roles_clearance_range;
ALTER TABLE roles ADD COLUMN color text NOT NULL DEFAULT 'neutral';
ALTER TABLE roles ADD CONSTRAINT roles_color_palette CHECK (
  color IN ('red','rose','pink','fuchsia','purple','violet','indigo','blue',
            'sky','cyan','teal','emerald','green','lime','amber','neutral')
);
DROP INDEX IF EXISTS roles_org_name_key;
CREATE UNIQUE INDEX roles_name_key ON roles(name);
```

`name` is now globally UNIQUE (previously `(org_id, name)`).

### Dropped tables

```sql
DROP TABLE IF EXISTS player_role_assignments CASCADE;
DROP TABLE IF EXISTS role_server_scopes      CASCADE;
DROP TABLE IF EXISTS organization_members    CASCADE;
DROP TABLE IF EXISTS organizations           CASCADE;
ALTER TABLE audit_log DROP COLUMN org_id;
TRUNCATE player_api_tokens;
DELETE FROM role_permissions;  -- the seeder will refill it
```

### Seeding the 5 roles in the SQL migration

`Owner` (red, system) / `Senior Admin` (amber) / `Admin` (sky) / `Moderator` (emerald) / `Viewer` (neutral). The exact permission sets are in section 4. After the INSERTs and loading `role_permissions` — `UPDATE panel_meta SET roles_seeded = true`.

### Drizzle schema files

- **Delete**: `organizations.ts`, `organization-members.ts`, `role-server-scopes.ts`, `player-role-assignments.ts`.
- **Change**: `roles.ts` (without `orgId`/`clearanceLevel`, +`color`), `players.ts` (+`roleId`), `audit-log.ts` (without `orgId`).
- **Create**: `panel-meta.ts`.

---

## 4. Permission registry

### Shape

`packages/shared-config/src/permissions.ts` — registry objects:

```ts
export const PERMISSION_CATEGORIES = [
  'servers', 'configs', 'players', 'moderation',
  'admin_groups', 'whitelist', 'host', 'audit',
  'events', 'users', 'roles', 'backup',
  'api_tokens', 'discord', 'triggers', 'scheduler',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDef {
  key: string;
  category: PermissionCategory;
  label: string;
  dangerous?: true;
  unimplemented?: true;
}

export const PERMISSIONS: readonly PermissionDef[] = [ /* see below */ ];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
```

### Full registry

| Category | Key | Label (ru) | Flags |
|---|---|---|---|
| servers | `server:view` | Видеть серверы и их статус (See servers and their status) | |
| servers | `server:install` | Устанавливать серверы (Install servers) | dangerous |
| servers | `server:start` | Start сервера (Start the server) | |
| servers | `server:stop` | Stop (graceful) | |
| servers | `server:force_stop` | Force-stop (kill) | dangerous |
| servers | `server:restart` | Restart | |
| servers | `server:delete` | Удалить сервер с очисткой (Delete a server with cleanup) | dangerous |
| servers | `server:edit_settings` | Resource limits, ports, max\_players | |
| servers | `server:update` | app\_update через SteamCMD (app\_update via SteamCMD) | |
| configs | `config:view` | Читать .cfg файлы (Read .cfg files) | |
| configs | `config:edit` | Редактировать через Monaco (Edit via Monaco) | |
| configs | `config:rollback` | Откат к предыдущей версии (Roll back to the previous version) | |
| players | `player:view` | Список игроков, ник, SteamID (Player list, nickname, SteamID) | |
| players | `player:view_ips` | История IP (IP history) | |
| players | `player:view_notes` | Заметки про игрока (Notes about a player) | unimplemented |
| players | `player:edit_notes` | Редактировать заметки (Edit notes) | unimplemented |
| players | `player:set_flags` | Custom теги (toxic, helpful) (Custom tags (toxic, helpful)) | unimplemented |
| moderation | `mod:kick` | Kick через UI (Kick via the UI) | dangerous, unimplemented |
| moderation | `mod:warn` | Warn | unimplemented |
| moderation | `mod:ban_temp` | Temp ban | dangerous, unimplemented |
| moderation | `mod:ban_perm` | Permanent ban | dangerous, unimplemented |
| moderation | `mod:unban` | Unban | unimplemented |
| admin\_groups | `admin_group:view` | Видеть Admins.cfg (See Admins.cfg) | unimplemented |
| admin\_groups | `admin_group:edit` | Редактировать Admins.cfg (Edit Admins.cfg) | unimplemented |
| whitelist | `whitelist:view` | Видеть whitelist (See the whitelist) | unimplemented |
| whitelist | `whitelist:edit` | Управлять whitelist (Manage the whitelist) | unimplemented |
| host | `host:view` | Dashboard host info | |
| host | `host:metrics` | Метрики (CPU/RAM/Disk/Net + история) (Metrics (CPU/RAM/Disk/Net + history)) | |
| host | `host:manage` | Управление хост-демоном (restart bridge) (Manage the host daemon (restart bridge)) | dangerous |
| audit | `audit:view` | Читать audit log (Read the audit log) | |
| audit | `audit:export` | Export audit в CSV (Export the audit to CSV) | unimplemented |
| events | `events:view` | Game events log | |
| users | `user:view` | Список пользователей панели (List of panel users) | |
| users | `user:manage_roles` | Назначать роли (Assign roles) | dangerous |
| roles | `role:view` | Видеть роли (See roles) | |
| roles | `role:create` | Создавать роли (Create roles) | |
| roles | `role:edit` | Редактировать роли (Edit roles) | |
| roles | `role:delete` | Удалять роли (Delete roles) | dangerous |
| backup | `backup:view` | Список backups (List of backups) | unimplemented |
| backup | `backup:trigger` | Запустить backup (Start a backup) | unimplemented |
| backup | `backup:restore` | Restore из snapshot (Restore from a snapshot) | dangerous, unimplemented |
| api\_tokens | `api_token:create` | Создавать API tokens (Create API tokens) | |
| api\_tokens | `api_token:revoke` | Ревокать tokens (Revoke tokens) | |
| discord | `discord:link` | Привязать Discord (Link Discord) | unimplemented |
| triggers | `trigger:view` | Видеть авто-правила (See auto-rules) | unimplemented |
| triggers | `trigger:edit` | Редактировать авто-правила (Edit auto-rules) | unimplemented |
| scheduler | `scheduler:view` | Видеть запланированные задачи (See scheduled tasks) | unimplemented |
| scheduler | `scheduler:edit` | Редактировать расписание (Edit the schedule) | unimplemented |

### Renames from the existing code

| Was | Now |
|---|---|
| `server:create` | dropped (absorbed by `server:install`) |
| `server:edit` | `server:edit_settings` |
| `server:config:write` | `config:edit` |
| `server:config:history` | `config:rollback` (plus the new `config:view`) |
| `player:view_eos_id` | dropped (part of `player:view`) |
| `player:view_steam_id` | dropped (part of `player:view`) |
| `user:create` / `user:edit` / `user:delete` | dropped (there is no such workflow) |
| `role:manage` | split into `role:view` / `role:create` / `role:edit` / `role:delete` |
| `permission:manage` | dropped (the registry is static in code) |
| `host:bridge_control` | `host:manage` (renamed, now dangerous; replaces the erroneous mapping to `host:metrics`) |
| `org:view` / `org:edit` | dropped (orgs are removed) |

All `config: { permissions: [...] }` in the existing routes are updated in the same series of commits. `audit-coverage.test.ts` catches any misses.

### Default permission sets for the system roles

| Role | Permissions |
|---|---|
| **Owner** | all keys from `PERMISSIONS` (including unimplemented) |
| **Senior Admin** | everything except `server:delete`, `role:delete`, `backup:restore` |
| **Admin** | `server:view/start/stop/restart/edit_settings`, `config:view/edit/rollback`, `player:view/view_ips`, `mod:kick/warn/ban_temp/unban`, `admin_group:view`, `whitelist:view/edit`, `host:view/metrics`, `audit:view`, `events:view`, `api_token:create/revoke` |
| **Moderator** | `server:view`, `player:view`, `mod:kick/warn/ban_temp/unban`, `events:view` |
| **Viewer** | `server:view`, `config:view`, `player:view`, `audit:view`, `host:view`, `events:view`, `role:view`, `user:view`, `admin_group:view`, `whitelist:view`, `backup:view`, `trigger:view`, `scheduler:view` |

### Color palette

`packages/shared-config/src/role-colors.ts`:

```ts
export const ROLE_COLORS = [
  'red', 'rose', 'pink', 'fuchsia', 'purple', 'violet', 'indigo', 'blue',
  'sky', 'cyan', 'teal', 'emerald', 'green', 'lime', 'amber', 'neutral',
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
```

The slug names match Tailwind classes (`bg-red-500`, `text-red-400`, etc.) — no ad-hoc mappings in the UI. The CHECK in SQL duplicates the list — synchronization is enforced by a unit test.

---

## 5. API surface

### New / changed endpoints

| Method | Path | Permission | Audit action | Body / response |
|---|---|---|---|---|
| GET | `/api/v1/permissions` | `role:view` | — | `[{key, category, label, dangerous?, unimplemented?}, ...]` |
| GET | `/api/v1/roles` | `role:view` | — | `[{id, name, color, is_system_role, description, permissions: [...], assigned_users_count}, ...]` |
| POST | `/api/v1/roles` | `role:create` | `role.create` | body: `{ name, color, description?, permissions: PermissionKey[] }` |
| GET | `/api/v1/roles/:id` | `role:view` | — | full role object |
| PUT | `/api/v1/roles/:id` | `role:edit` | `role.update` | body: `{ name?, color?, description?, permissions? }`. 400 for Owner |
| DELETE | `/api/v1/roles/:id` | `role:delete` | `role.delete` | 400 for Owner. Cascades to `players.role_id = NULL` |
| GET | `/api/v1/users` | `user:view` | — | `[{steam_id64, canonical_name, role: {...}, assigned_at, assigned_by, last_seen_at}, ...]` |
| GET | `/api/v1/players/:steamId/role` | `user:view` | — | `{role: {...} \| null}` |
| PUT | `/api/v1/players/:steamId/role` | `user:manage_roles` | `player.role.assign` | body: `{ role_id: uuid \| null }`. 409 when trying to remove the last Owner |

### Removed endpoints

- `GET /api/v1/players/:steamId/roles` (M:N list)
- `POST /api/v1/players/:steamId/roles` (M:N add)
- `DELETE /api/v1/players/:steamId/roles/:roleId` (M:N remove)
- `GET /api/v1/setup/check-env`
- `POST /api/v1/setup/init`

### First-login Owner trick

In `apps/api/src/routes/auth-steam.ts`, after a successful Steam OpenID, **inside a single transaction** with an advisory lock (the pattern from `d854971`):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('panel_meta_first_owner', 0));
SELECT first_owner_claimed FROM panel_meta WHERE id = 1;
-- if NOT first_owner_claimed AND NOT EXISTS (SELECT 1 FROM players p
--   JOIN roles r ON r.id = p.role_id WHERE r.name = 'Owner'):
UPDATE players SET role_id = (SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true)
  WHERE steam_id64 = $1;
UPDATE panel_meta SET first_owner_claimed = true WHERE id = 1;
COMMIT;
```

If the flag is already `true` or an Owner exists — the normal flow: the cookie is set, then the middleware decides (a role exists → panel, none → `/no-access`).

### Cache invalidation

In `apps/api/src/lib/rbac.ts`:

```ts
export function invalidatePermissionCache(steamId64: bigint): void;
export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void>;
```

Called:
- `PUT /players/:id/role` → `invalidatePermissionCache(steamId64)`.
- `PUT /roles/:id` (permissions were changed) → `invalidatePermissionCacheForRole(roleId)`.
- `DELETE /roles/:id` → `invalidatePermissionCacheForRole(roleId)` (the holders will lose the role anyway via `ON DELETE SET NULL`, but the cache is cleared explicitly).

The 30s TTL remains as a safety net.

### Removed from rbac.ts

- `hasServerPermission` — there is no per-server scoping.
- The `clearance` logic in `loadUserPermissions` (it used to be a `MAX` over several roles, no longer needed).

---

## 6. UI

### New pages

**`/roles`** (permission `role:view`)
Role list. Columns: a colored marker dot to the left of the name, name, description, "пользователей: N" (users: N), `is_system_role` badge "Системная" (System) for Owner, buttons "Редактировать" (Edit) / "Удалить" (Delete) (the latter is disabled for Owner). A "Создать роль" (Create role) button at the top (only if the user has the `role:create` permission).

**`/roles/new`** and **`/roles/:id`** (permissions `role:create` / `role:edit`)
Role editor. Blocks:
1. Name (`<input>`) + a color picker (a grid of 16 swatches).
2. Description (`<textarea>`, optional).
3. Permissions: a search bar (realtime filter by `label.toLowerCase().includes(q) || key.includes(q)`), under it 16 categories in a three-column responsive grid. Each category has checkboxes with labels, a ⚠️ badge on the right for `dangerous`, and a "dimmed" style (opacity-50 + the caption "в разработке" (in development)) for `unimplemented`.
4. Owner — read-only mode: instead of the "Сохранить" (Save) button — an alert "Системная роль. Permissions нельзя редактировать." (System role. Permissions cannot be edited.), all checkboxes disabled.
5. A "Скопировать права из…" (Copy permissions from…) button (P1, a dropdown with the other roles) in the create form. When one is selected, the checkboxes are pre-filled with the permissions of the selected role.
6. "Сохранить" (Save) / "Отмена" (Cancel) buttons.

**`/users`** (permission `user:view`)
Table. Columns: nickname + the role's colored dot, SteamID64 (monospaced, a link to the Steam profile), role name, who/when assigned, last\_seen. A "Назначить роль игроку" (Assign a role to a player) button → a modal: typeahead search over `players` (debounced GET to `/api/v1/players?q=`), on selection — a roles dropdown (there is no empty option = "remove role": for an assignment, having no role makes no sense), a "Назначить" (Assign) button (requires `user:manage_roles`).

When **Owner** is selected in any dropdown (on `/users` or on `/players/:id`) — a confirm dialog: "Это даст пользователю **полный доступ** к панели. Подтвердить?" (This will give the user **full access** to the panel. Confirm?) Without confirmation the PUT is not sent. This reduces the escalation risk (see Section 10).

### Changed pages

**`/players/:steam_id64`** — the `PanelAccessSection`
Currently (after `825d94c`) it renders a list of several roles with "Удалить" (Delete) buttons. After the changes: a single "Роль" (Role) field — read-only text with a colored dot if there is a role, "—" if there is none. Buttons next to it: "Изменить" (Edit; opens an inline roles dropdown) and "Снять роль" (Remove role; if there is a role). The Owner-lockout 409 is shown with a clear message.

### Removed pages

- **`/setup`** (the entire `apps/web/src/app/setup/` directory) — the wizard goes away.
- **Login redirect**: in `apps/web/src/app/login/`, the redirect to `/setup` (commit `9c938ca`) is removed.

### Sidebar / nav

Items added:
- "Роли" (Roles) under `role:view`
- "Пользователи" (Users) under `user:view`

In `apps/web/src/app/(dashboard)/layout.tsx` (or wherever the nav lives) — dynamic filtering by `req.user.permissions`.

---

## 7. Migration sequence

The current branch `feat/steam-only-login` is merged into master (it is ready, api-tokens are complete, the decision record is written). The new work goes in the `feat/panel-rbac` branch. A series of commits:

1. **`feat(db): 0009_panel_rbac migration + drizzle schema rebuild`** — a single-transaction SQL: drop the org tables + M:N + role\_server\_scopes, alter roles (drop org\_id/clearance, add color), alter players (add role\_id), create panel\_meta, truncate role\_permissions + player\_api\_tokens, INSERT the 5 system roles and their permissions, `panel_meta.roles_seeded = true`. Drizzle schema: delete/add/change files. Delete `packages/db/src/seed/system-roles.ts`.
2. **`feat(shared-config): permission registry + role colors`** — registry objects, the role-colors palette, `permissions.test.ts`, `role-defaults.test.ts`, `role-colors.test.ts`.
3. **`refactor(api/rbac): single-role lookup + invalidation`** — rewrite `loadUserPermissions` on top of `players.role_id`, add `invalidatePermissionCacheForRole`, delete `hasServerPermission`. Unit tests.
4. **`feat(api/roles): GET /permissions + CRUD /roles`** — endpoints with the Owner guard and auditing.
5. **`feat(api/users): GET /users + PUT /players/:id/role`** — delete the old `/players/:id/roles` endpoints. The Owner-lockout invariant.
6. **`feat(api/auth): first-login owner trick + drop /setup`** — the advisory-lock scenario in the Steam callback, delete `routes/setup.ts`. Permission renames in all `config.permissions`. `audit-coverage.test.ts` updates automatically.
7. **`feat(web/roles): /roles list + editor`** — color picker, search over permissions, categories, ⚠️/unimplemented styles.
8. **`feat(web/users): /users table + assign modal`** — typeahead, roles dropdown.
9. **`refactor(web): single-role PanelAccessSection + drop /setup + nav`** — rewrite the section on `/players/:id`, delete `/setup`, add the sidebar items.
10. **`docs(rbac): component dir + decision record + cross-references`** — `docs/components/rbac/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`. Update `docs/architecture/rbac.md` (single-role + the new registry). A decision record in `docs/architecture/decisions.md`. Remove mentions of `/setup` and `clearance` from all the old docs.

After each step: `pnpm turbo run typecheck && pnpm turbo run test` is green AND a **manual e2e on the live stand** following the scenario from section 8.

---

## 8. Testing approach

### Tier 1 — unit

- **`permissions.test.ts`**: keys are unique, all categories from `PERMISSION_CATEGORIES` exist (no orphans), `dangerous`/`unimplemented` are `true | undefined`, never `false`.
- **`role-defaults.test.ts`**: every key in the default permission sets (Owner / Senior Admin / Admin / Moderator / Viewer) ∈ `PERMISSION_KEYS`. Owner = ALL. Viewer contains nothing except `*:view`.
- **`role-colors.test.ts`**: `ROLE_COLORS` matches the CHECK constraint in the SQL migration (reads the migration file text and parses it).
- **`rbac.test.ts`**: `loadUserPermissions(NULL role_id)` → an empty set; non-NULL → the correct set; cache hit/miss; `invalidatePermissionCache` clears the key; `invalidatePermissionCacheForRole` finds all holders and clears them.

### Tier 2 — integration (apps/api/test/)

- **`roles-crud.test.ts`** — POST/GET/PUT/DELETE with different permission fixtures. Owner is read-only (PUT/DELETE → 400). UNIQUE name (POST of a duplicate → 409). `assigned_users_count` in GET is correct.
- **`player-role-assign.test.ts`** — PUT with a valid role\_id; PUT with a nonexistent one → 404; PUT `null` removes the role; Owner-lockout: an attempt to remove the last Owner → 409. Cache invalidation: PUT, then a fake request that checks permissions — it must use the new set without waiting for the TTL.
- **`users-list.test.ts`** — GET filters by `role_id NOT NULL`; the join with roles works; `assigned_at`/`assigned_by` are present.
- **`permissions-list.test.ts`** — GET returns exactly `PERMISSIONS.length` objects with the right fields.
- **`first-owner-trick.test.ts`** — two concurrent logins yield exactly one Owner (advisory lock). After `first_owner_claimed = true`, the next fresh login gets `role_id = NULL`.
- **`audit-coverage.test.ts`** — updates automatically (route walker).
- **`setup-removed.test.ts`** — `/api/v1/setup/check-env`, `/api/v1/setup/init` return 404.
- **`permission-rename-coverage.test.ts`** — greps all the TS files in apps/api/src for the old keys (`server:edit`, `server:config:write`, `role:manage`, etc.) — it must return 0 matches (protection against a missed rename).

### Tier 3 — e2e (apps/api/test/e2e/)

**`panel-rbac.e2e.test.ts`** — a new file next to `install-lifecycle.e2e.test.ts`. A scenario over HTTP with a real cookie:

1. POST `/api/v1/roles` body `{name: "Test", color: "blue", permissions: ["server:view"]}` → 201, returns the id.
2. PUT `/api/v1/players/:secondary/role` `{role_id: testId}` → 200.
3. GET `/api/v1/servers` as the secondary user → 200 (has `server:view`).
4. GET `/api/v1/audit` as secondary → 403 (no `audit:view`).
5. PUT `/api/v1/roles/:testId` body `{permissions: []}` → 200.
6. GET `/api/v1/servers` as secondary → 403 (invalidation worked, no waiting for the TTL).
7. DELETE `/api/v1/roles/:testId` → 200.
8. GET `/api/v1/me` as secondary → role: null.
9. PUT `/api/v1/players/:owner/role` `{role_id: null}` → 409 `cannot_remove_last_owner`.

### Manual validation gate (a user requirement)

After **each** of steps 1-9, the operator goes through this by hand:

1. Log in as Owner. They see `/roles`, `/users` in the sidebar.
2. Create a "Test" role with the color blue, grant it `server:view`.
3. Via `/users`, assign the role to a second player (using the typeahead search).
4. Log in as that player. The sidebar shows only "Серверы" (Servers) (no other items).
5. The Owner edits the "Test" role → removes `server:view` → the second player gets a 403/redirect on the next click.
6. The Owner deletes the "Test" role → the second player lands on `/no-access` on the next request.
7. The Owner restores access on `/players/:secondary` (grants Viewer).

Without green automated tests **AND** a manual pass, a step is not considered complete. This is a blocking gate.

---

## 9. Out of scope

- **Hierarchy / clearance levels** — rejected.
- **Per-server permission scoping** — rejected, the `role_server_scopes` table is dropped.
- **Multi-tenancy / orgs** — `organizations` is dropped.
- **Setup wizard / env-check page** — removed, the first-login Owner trick on the Steam callback replaces it.
- **Bulk operations in `/users`** (mass assign/revoke) — a future P1.
- **Role composition / inheritance** — a role is flat, no "Senior Admin extends Admin".
- **Expiring role assignments** — an assignment is permanent.
- **A UI for managing the permission registry** — the registry is code; a programmer changes it.
- **Triggers / Scheduler / Whitelist / Backup / Discord / Moderation actions / Player notes** UI — the permissions are added as `unimplemented` stubs; routes/UI are separate epics.
- **Discord link** — the `discord:link` permission is a stub; UI/route is a separate epic.

---

## 10. Risks

- **Escalation via `user:manage_roles`**: a user with this permission can grant someone Owner. Mitigation: document it as "give to trusted only"; in the UI — a confirm dialog when assigning Owner ("Это даст полный доступ к панели. Подтвердить?" (This will give full access to the panel. Confirm?)); a ⚠️ badge on the permission in the editor.
- **In-memory cache in a multi-instance API**: targeted invalidation works only within a single process. For now compose runs one instance — not a blocker. With horizontal scaling — Redis pub/sub in a separate epic.
- **Permission rename drift**: if a route references an old name, the types will catch it (the PermissionKey union); `permission-rename-coverage.test.ts` is the backstop.
- **Role seeder in SQL vs Drizzle types**: the migration INSERTs roles with fixed names; the Drizzle types know nothing about specific UUIDs. The tests expect records to be present by `name`, not by id — this is acceptable, the names are stable.
- **`is_system_role = true` only for Owner**: an operator can delete, for example, Moderator. After that nobody recreates it automatically (by design). This is documented in `troubleshooting.md`.
