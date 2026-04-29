# Changelog

## 2026-05-01 — Эпик 2 Phase 2: roles unified with Squad in-game permissions

### Added

- Three boolean access flags on `roles`: `panel_access`, `can_assign_roles`, `can_edit_roles`. The login flow now gates panel access on `panel_access=true` (replacing the prior "any panel permission ⇒ allowed" behaviour).
- 21-key Squad in-game permission catalogue (`@squad/shared-config/squad-permissions`) and the `role_squad_permissions` storage table. These power the managed segment of `Admins.cfg` written by `worker-config-sync`.
- `loadUserPermissions` (`apps/api/src/lib/rbac.ts`) now derives panel permissions from the flags at request time. `panel_access=true` grants the full panel permission set minus `role:create/edit/delete` (gated by `can_edit_roles`) and `user:manage_roles` (gated by `can_assign_roles`). Owner is hardcoded to all three flags + all 21 Squad permissions.
- Explicit rows in `role_permissions` are still honoured and unioned with the flag-derived set — back-compat with the legacy fine-grained model.
- New convenience `invalidateAllPermissionCaches()` exported for use after sweeping mutations (role delete, member removal).

### Changed

- Spec-default seed roles changed: was {Owner, Senior Admin, Admin, Moderator, Viewer}; is now {Owner, Admin, Moderator, QueuePriority, Cameraman, Intern}. Viewer was left in DB for test fixture back-compat; Senior Admin was removed.
- Role colors are now hex codes (`#FF0000` etc.) for the spec roles. Back-compat tailwind palette names still validated.
- `players.role_id` removal (role unassign) revokes all live sessions of the affected player; same for `DELETE /api/v1/roles/:id` and `DELETE /api/v1/roles/:id/members/:steamId`.
- Owner is no longer assignable via the API: `PUT /api/v1/players/:steam_id64/role { role_id: <owner_id> }` returns 403 `owner_assignment_forbidden`. Direct DB modification is still required for ownership transfer.

## 2026-04-25 (later)

### Fixed

- **`claimFirstOwner` no longer trusts the host sentinel as authoritative.** The DB (`panel_meta.first_owner_claimed`) is now the sole source of truth; the sentinel file `/var/lib/squad-panel/.first-owner-claimed` is written after a successful claim but never short-circuits a future claim attempt. This fixes the wedge where reinstalls (DB reset) inherited a stale sentinel and could not bootstrap a new Owner. Added `readSentinelHint()` for ops/forensic introspection. Test `'sentinel short-circuits before tx'` replaced with `'DB is authoritative — stale sentinel does not block a fresh claim'`. See `troubleshooting.md` "Wedge after reinstall".

## 2026-04-25

### Added

- **Permission registry** (`packages/shared-config/src/permissions.ts`) — replaced the flat string array with `PermissionDef` objects carrying `{key, category, label, dangerous?, unimplemented?}`. 44 permission keys across 16 categories. `PERMISSION_KEYS` and `PermissionKey` type exported.
- **Role-color palette** (`packages/shared-config/src/role-colors.ts`) — `ROLE_COLORS` constant (16 Tailwind slug values). SQL CHECK `roles_color_palette` mirrors the list; `role-colors.test.ts` asserts sync.
- **`panel_meta` singleton table** — tracks `first_owner_claimed` and `roles_seeded`. Replaces the `organizations.settings` field used by the old setup wizard.
- **Single-role model** — `players.role_id uuid NULL` with `ON DELETE SET NULL`. Replaces `player_role_assignments` M:N table.
- **`GET /api/v1/permissions`** — dumps the full registry. Requires `role:view`.
- **Roles CRUD** (`GET/POST/PUT/DELETE /api/v1/roles`) — with Owner immutability guard and cache invalidation.
- **`GET /api/v1/users`** — list of players with a non-NULL role.
- **`GET/PUT /api/v1/players/:steamId/role`** — single-role read and assign. Owner-lockout 409.
- **First-login Owner trick** — `claimFirstOwner()` in `apps/api/src/lib/first-owner.ts` uses `panel_meta` and an advisory lock to assign the Owner role to the very first Steam login on a fresh panel.
- **Cache invalidation** — `invalidatePermissionCache(steamId64)` and `invalidatePermissionCacheForRole(db, roleId)` in `apps/api/src/lib/rbac.ts`.
- **Web — `/roles`** — list with color dot, user count, edit/delete. `is_system_role` badge for Owner.
- **Web — `/roles/new` and `/roles/:id`** — role editor: name, 16-swatch color picker, optional description, permission grid with search, category grouping, `⚠` and "в разработке" styling.
- **Web — `/users`** — table of players with roles, assign-role modal with typeahead player search, Owner confirm dialog.
- **Web — `PanelAccessSection` on `/players/:id`** — simplified from M:N list to single-role display with inline assign/remove.
- **Sidebar nav** — "Роли" (gated by `role:view`) and "Пользователи" (gated by `user:view`).
- **Tests** — `permissions.test.ts`, `role-colors.test.ts` (unit); `permissions-list.test.ts`, `roles-crud.test.ts`, `player-role-assign.test.ts`, `users-list.test.ts`, `first-owner.test.ts`, `setup-removed.test.ts`, `permission-rename-coverage.test.ts` (integration); `panel-rbac.e2e.test.ts` (e2e).

### Changed

- `loadUserPermissions` in `apps/api/src/lib/rbac.ts` rewritten to use `players.role_id` instead of `player_role_assignments` M:N lookup. Removed `hasServerPermission` and clearance-level `MAX` logic.
- All `config.permissions` entries in `apps/api/src/routes/` updated to new permission key names (renames: `server:edit` → `server:edit_settings`, `server:config:write` → `config:edit`, `server:config:history` → `config:rollback`, `role:manage` → `role:view/create/edit/delete`, `host:bridge_control` → `host:manage`).

### Removed

- `player_role_assignments` table (M:N, replaced by `players.role_id`).
- `role_server_scopes` table (per-server permission scoping, unused).
- `organizations` and `organization_members` tables (multi-tenancy removed).
- `audit_log.org_id` column.
- `packages/db/src/schema/organizations.ts`, `organization-members.ts`, `role-server-scopes.ts`, `player-role-assignments.ts`.
- `packages/db/src/seed/system-roles.ts` — seeding moved into migration `0009_panel_rbac.sql`.
- `apps/api/src/routes/setup.ts` — setup wizard removed; replaced by first-login Owner trick.
- `apps/web/src/app/setup/` — setup pages removed.
- Old M:N player role endpoints: `GET/POST /players/:id/roles`, `DELETE /players/:id/roles/:roleId`.
- `ROLE_CLEARANCE` and `SYSTEM_ROLE_CLEARANCE` exports from `@squad/shared-config`.

### Migration notes

- Migration `0009_panel_rbac.sql` is destructive and forward-only. It drops `player_role_assignments`, `role_server_scopes`, `organizations`, `organization_members`, truncates `player_api_tokens`, alters `roles` and `players`, creates `panel_meta`, and seeds five system roles.
- After applying `0009`, no `pnpm db:migrate` rollback path exists.
- `audit_log.org_id` column is dropped in migration `0009`; the hash chain is unaffected because the column was always NULL before that migration.
