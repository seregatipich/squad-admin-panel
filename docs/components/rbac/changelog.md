# Changelog

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
