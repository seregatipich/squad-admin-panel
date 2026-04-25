# Panel RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Эпик 2 (Panel RBAC): single role per user, global roles, registry-based permissions with categories/danger/unimplemented metadata, 5 system roles seeded once, CRUD UI for roles, dedicated `/users` page, first-login Owner trick replacing the setup wizard.

**Architecture:** Pre-launch destructive forward-only migration on a fresh branch. Drops `player_role_assignments` (M:N), `role_server_scopes`, `organizations`, `organization_members`. Adds `players.role_id uuid NULL` and singleton `panel_meta`. Permission registry lives in `packages/shared-config` as objects with `{key, category, label, dangerous?, unimplemented?}`. UI gets new `/roles` and `/users` pages; `/setup` is removed.

**Tech Stack:** Postgres (Drizzle), Fastify 5 + Zod, Next.js 15 + React 19, Tailwind 4, Vitest, pnpm + Turbo.

---

## File Structure

### Packages

| Path | Action | Responsibility |
|---|---|---|
| `packages/db/drizzle/0009_panel_rbac.sql` | Create | Single-transaction migration (all schema changes + role seed) |
| `packages/db/src/schema/organizations.ts` | Delete | Multi-tenancy gone |
| `packages/db/src/schema/organization-members.ts` | Delete | Multi-tenancy gone |
| `packages/db/src/schema/role-server-scopes.ts` | Delete | Per-server scoping gone |
| `packages/db/src/schema/player-role-assignments.ts` | Delete | M:N gone, replaced by `players.role_id` |
| `packages/db/src/schema/roles.ts` | Modify | Drop `orgId`, `clearanceLevel`; add `color` |
| `packages/db/src/schema/players.ts` | Modify | Add `roleId` |
| `packages/db/src/schema/audit-log.ts` | Modify | Drop `orgId` |
| `packages/db/src/schema/panel-meta.ts` | Create | Singleton-meta table for `first_owner_claimed`, `roles_seeded` |
| `packages/db/src/schema/index.ts` | Modify | Re-export panel-meta, remove deleted schemas |
| `packages/db/src/seed/system-roles.ts` | Delete | Seeding moves to SQL migration |
| `packages/db/src/seed/index.ts` | Modify | Drop the export |
| `packages/shared-config/src/permissions.ts` | Modify | Replace flat string array with registry-objects array |
| `packages/shared-config/src/role-colors.ts` | Create | 16-color palette enum |
| `packages/shared-config/src/index.ts` | Modify | Export `ROLE_COLORS`, drop `ROLE_CLEARANCE`/`SYSTEM_ROLE_CLEARANCE` |
| `packages/shared-config/test/permissions.test.ts` | Create | Registry consistency unit test |
| `packages/shared-config/test/role-colors.test.ts` | Create | Palette ↔ SQL CHECK sync test |

### API

| Path | Action | Responsibility |
|---|---|---|
| `apps/api/src/lib/rbac.ts` | Modify | Single-role lookup; new `invalidatePermissionCacheForRole`; drop `hasServerPermission` |
| `apps/api/src/lib/first-owner.ts` | Modify | Use `panel_meta` instead of `organizations.settings`; add Owner role lookup by `name='Owner' AND is_system_role=true` |
| `apps/api/src/routes/permissions.ts` | Create | `GET /api/v1/permissions` (registry dump) |
| `apps/api/src/routes/roles.ts` | Create | CRUD `/api/v1/roles/*` with Owner-guard + audit |
| `apps/api/src/routes/users.ts` | Create | `GET /api/v1/users` (players with role) |
| `apps/api/src/routes/players.ts` | Modify | Drop M:N endpoints; add `GET /api/v1/players/:steamId/role`, `PUT /api/v1/players/:steamId/role` (with Owner-lockout) |
| `apps/api/src/routes/setup.ts` | Delete | Wizard gone |
| `apps/api/src/routes/auth-steam.ts` | Modify | First-login Owner trick uses new `claimFirstOwner` (panel_meta-based) |
| `apps/api/src/server.ts` | Modify | Wire new routes, drop setup |
| `apps/api/test/permissions-list.test.ts` | Create | GET /permissions integration |
| `apps/api/test/roles-crud.test.ts` | Create | CRUD + Owner-guard + UNIQUE name |
| `apps/api/test/player-role-assign.test.ts` | Create | PUT/GET role + Owner-lockout + cache invalidation |
| `apps/api/test/users-list.test.ts` | Create | GET /users filters by role_id NOT NULL |
| `apps/api/test/first-owner.test.ts` | Modify | Adapt to panel_meta-based logic |
| `apps/api/test/players-roles.test.ts` | Delete | Old M:N test |
| `apps/api/test/setup.test.ts` | Delete | /setup gone |
| `apps/api/test/setup-removed.test.ts` | Create | Verify /api/v1/setup/* return 404 |
| `apps/api/test/permission-rename-coverage.test.ts` | Create | Grep-based guard against stale permission keys |
| `apps/api/test/audit-coverage.test.ts` | Modify | Update plugin imports (drop setup, add roles/users routes) |
| `apps/api/test/e2e/panel-rbac.e2e.test.ts` | Create | E2E: create role → assign → verify access → modify → revoke |

### Web

| Path | Action | Responsibility |
|---|---|---|
| `apps/web/src/app/(dashboard)/roles/page.tsx` | Create | Roles list + delete-confirm + create button |
| `apps/web/src/app/(dashboard)/roles/new/page.tsx` | Create | Create role |
| `apps/web/src/app/(dashboard)/roles/[id]/page.tsx` | Create | Edit role (Owner read-only) |
| `apps/web/src/components/RoleEditor.tsx` | Create | Shared editor: name, color-picker, search, permissions grid |
| `apps/web/src/components/RoleColorDot.tsx` | Create | Single component used everywhere a role color shows |
| `apps/web/src/app/(dashboard)/users/page.tsx` | Create | Users table + assign-role modal |
| `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx` | Modify | Simplify PanelAccessSection to single role; Owner confirm-dialog |
| `apps/web/src/app/(dashboard)/layout.tsx` | Modify | Add "Роли", "Пользователи" nav items; permission-gated |
| `apps/web/src/app/login/page.tsx` | Modify | Remove `/setup` redirect |
| `apps/web/src/app/setup/` | Delete | Wizard gone |

### Documentation

| Path | Action |
|---|---|
| `docs/components/rbac/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md` | Create |
| `docs/architecture/rbac.md` | Modify (rewrite for single-role + registry) |
| `docs/architecture/decisions.md` | Modify (add new decision record) |
| `docs/architecture/data-flow.md` | Modify (mention `panel_meta`, drop org refs) |
| `docs/components/db/data-model.md` | Modify (single-role + panel_meta) |
| `docs/components/api/api.md` | Modify (new routes) |

---

## Pre-Task: Branch setup

### Task 0: Merge feat/steam-only-login + start feat/panel-rbac

**Files:** branch ops only

- [ ] **Step 1: Verify the current branch is shippable**

```bash
git status
pnpm turbo run typecheck
pnpm turbo run test
pnpm biome check .
```
Expected: clean working tree, all green.

- [ ] **Step 2: Push current branch (if not already), open / merge PR via GitHub UI**

If already merged into master, skip. Otherwise hand off to user — this plan does not auto-push.

- [ ] **Step 3: Sync master locally and create new branch**

```bash
git checkout master
git pull origin master
git checkout -b feat/panel-rbac
```
Expected: on `feat/panel-rbac`, fresh from master.

- [ ] **Step 4: Sanity-test before any changes**

```bash
pnpm install
pnpm turbo run typecheck
pnpm turbo run test
```
Expected: all green.

---

## Task 1: SQL migration 0009 — schema reshape + role seed

**Files:**
- Create: `packages/db/drizzle/0009_panel_rbac.sql`

This migration is destructive forward-only (pre-launch, no prod data). Single transaction.

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0009_panel_rbac.sql`:

```sql
-- =====================================================================
-- 0009 — Panel RBAC (Эпик 2): single-role-per-user, drop multi-tenancy,
--   permission rename, palette CHECK, panel_meta singleton.
--
-- Destructive forward-only. Pre-launch — no prod data to preserve.
-- Rollback: git revert + DROP DATABASE + CREATE DATABASE + db:migrate.
-- =====================================================================

BEGIN;

-- 1. panel_meta singleton — replaces organizations.settings.first_owner_claimed
CREATE TABLE panel_meta (
  id                    smallint     PRIMARY KEY DEFAULT 1,
  first_owner_claimed   boolean      NOT NULL DEFAULT false,
  roles_seeded          boolean      NOT NULL DEFAULT false,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT panel_meta_singleton CHECK (id = 1)
);
INSERT INTO panel_meta (id) VALUES (1);

-- 2. Drop org-coupled FK on audit_log first (then dropping organizations
--    won't fail).
ALTER TABLE audit_log DROP COLUMN IF EXISTS org_id;

-- 3. Drop the M:N table — replaced by players.role_id.
DROP TABLE IF EXISTS player_role_assignments CASCADE;

-- 4. Drop per-server scoping table — never enforced.
DROP TABLE IF EXISTS role_server_scopes CASCADE;

-- 5. Drop multi-tenancy tables. organization_members must go before organizations.
DROP TABLE IF EXISTS organization_members CASCADE;
DROP TABLE IF EXISTS organizations        CASCADE;

-- 6. Reshape roles: drop org coupling and clearance, add color.
DROP INDEX IF EXISTS roles_org_name_key;
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_clearance_range;
ALTER TABLE roles DROP COLUMN IF EXISTS org_id;
ALTER TABLE roles DROP COLUMN IF EXISTS clearance_level;
ALTER TABLE roles ADD COLUMN color text NOT NULL DEFAULT 'neutral';
ALTER TABLE roles ADD CONSTRAINT roles_color_palette CHECK (
  color IN ('red','rose','pink','fuchsia','purple','violet','indigo','blue',
            'sky','cyan','teal','emerald','green','lime','amber','neutral')
);
CREATE UNIQUE INDEX roles_name_key ON roles(name);

-- 7. Add players.role_id (NULL = no panel access).
ALTER TABLE players ADD COLUMN role_id uuid REFERENCES roles(id) ON DELETE SET NULL;
CREATE INDEX players_role_id_idx ON players(role_id) WHERE role_id IS NOT NULL;

-- 8. TRUNCATE existing token table — pre-launch, scope renames invalidate
--    any locally-minted tokens.
TRUNCATE player_api_tokens;

-- 9. Wipe role_permissions — sider rebuilds from scratch.
DELETE FROM role_permissions;

-- 10. Wipe roles table itself (no FK remains since players.role_id was just
--     added with NULL default; player_role_assignments is gone).
DELETE FROM roles;

-- 11. Seed 5 system roles.
WITH new_roles AS (
  INSERT INTO roles (id, name, description, color, is_system_role) VALUES
    (gen_random_uuid(), 'Owner',         'Полный доступ. Системная роль, не редактируется.', 'red',     true),
    (gen_random_uuid(), 'Senior Admin',  'Всё кроме деструктивного.',                          'amber',   false),
    (gen_random_uuid(), 'Admin',         'Server lifecycle + moderation.',                     'sky',     false),
    (gen_random_uuid(), 'Moderator',     'Только модерация и просмотр игроков.',               'emerald', false),
    (gen_random_uuid(), 'Viewer',        'Только просмотр.',                                   'neutral', false)
  RETURNING id, name
)
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k FROM new_roles r CROSS JOIN LATERAL (
  SELECT k FROM unnest(CASE r.name
    WHEN 'Owner' THEN ARRAY[
      'server:view','server:install','server:start','server:stop','server:force_stop',
      'server:restart','server:delete','server:edit_settings','server:update',
      'config:view','config:edit','config:rollback',
      'player:view','player:view_ips','player:view_notes','player:edit_notes','player:set_flags',
      'mod:kick','mod:warn','mod:ban_temp','mod:ban_perm','mod:unban',
      'admin_group:view','admin_group:edit',
      'whitelist:view','whitelist:edit',
      'host:view','host:metrics',
      'audit:view','audit:export',
      'events:view',
      'user:view','user:manage_roles',
      'role:view','role:create','role:edit','role:delete',
      'backup:view','backup:trigger','backup:restore',
      'api_token:create','api_token:revoke',
      'discord:link',
      'trigger:view','trigger:edit',
      'scheduler:view','scheduler:edit'
    ]
    WHEN 'Senior Admin' THEN ARRAY[
      'server:view','server:install','server:start','server:stop','server:force_stop',
      'server:restart','server:edit_settings','server:update',
      'config:view','config:edit','config:rollback',
      'player:view','player:view_ips','player:view_notes','player:edit_notes','player:set_flags',
      'mod:kick','mod:warn','mod:ban_temp','mod:ban_perm','mod:unban',
      'admin_group:view','admin_group:edit',
      'whitelist:view','whitelist:edit',
      'host:view','host:metrics',
      'audit:view','audit:export',
      'events:view',
      'user:view','user:manage_roles',
      'role:view','role:create','role:edit',
      'backup:view','backup:trigger',
      'api_token:create','api_token:revoke',
      'discord:link',
      'trigger:view','trigger:edit',
      'scheduler:view','scheduler:edit'
    ]
    WHEN 'Admin' THEN ARRAY[
      'server:view','server:start','server:stop','server:restart','server:edit_settings',
      'config:view','config:edit','config:rollback',
      'player:view','player:view_ips',
      'mod:kick','mod:warn','mod:ban_temp','mod:unban',
      'admin_group:view',
      'whitelist:view','whitelist:edit',
      'host:view','host:metrics',
      'audit:view',
      'events:view',
      'api_token:create','api_token:revoke'
    ]
    WHEN 'Moderator' THEN ARRAY[
      'server:view',
      'player:view',
      'mod:kick','mod:warn','mod:ban_temp','mod:unban',
      'events:view'
    ]
    WHEN 'Viewer' THEN ARRAY[
      'server:view','config:view','player:view','audit:view','host:view','events:view',
      'role:view','user:view','admin_group:view','whitelist:view','backup:view',
      'trigger:view','scheduler:view'
    ]
  END) AS k
);

UPDATE panel_meta SET roles_seeded = true WHERE id = 1;

COMMIT;
```

- [ ] **Step 2: Apply migration on dev DB and verify**

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin psql -c "SELECT name, color, is_system_role FROM roles ORDER BY is_system_role DESC, name;"
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin psql -c "SELECT count(*) FROM role_permissions;"
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin psql -c "SELECT * FROM panel_meta;"
```

Expected:
- 5 roles (Owner system=t, then 4 others system=f).
- `role_permissions.count` ≈ 47 (Owner) + 41 (Senior Admin) + 19 (Admin) + 6 (Moderator) + 13 (Viewer) = 126.
- panel_meta has 1 row, `roles_seeded=true`, `first_owner_claimed=false`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/drizzle/0009_panel_rbac.sql
git commit -m "feat(db): 0009 panel-rbac migration — single-role + drop multi-tenancy + seed 5 roles"
```

---

## Task 2: Drizzle schema rebuild

**Files:**
- Delete: `packages/db/src/schema/organizations.ts`
- Delete: `packages/db/src/schema/organization-members.ts`
- Delete: `packages/db/src/schema/role-server-scopes.ts`
- Delete: `packages/db/src/schema/player-role-assignments.ts`
- Delete: `packages/db/src/seed/system-roles.ts`
- Create: `packages/db/src/schema/panel-meta.ts`
- Modify: `packages/db/src/schema/roles.ts`
- Modify: `packages/db/src/schema/players.ts`
- Modify: `packages/db/src/schema/audit-log.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/seed/index.ts`

- [ ] **Step 1: Delete obsolete schema files**

```bash
rm packages/db/src/schema/organizations.ts
rm packages/db/src/schema/organization-members.ts
rm packages/db/src/schema/role-server-scopes.ts
rm packages/db/src/schema/player-role-assignments.ts
rm packages/db/src/seed/system-roles.ts
```

- [ ] **Step 2: Rewrite roles.ts**

`packages/db/src/schema/roles.ts`:

```ts
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull().default('neutral'),
    isSystemRole: boolean('is_system_role').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    nameKey: uniqueIndex('roles_name_key').on(table.name),
  }),
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
```

- [ ] **Step 3: Add role_id to players.ts**

`packages/db/src/schema/players.ts` — add `roleId` column:

```ts
import { sql } from 'drizzle-orm';
import { bigint, index, inet, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles.js';

export const players = pgTable(
  'players',
  {
    steamId64: bigint('steam_id64', { mode: 'bigint' }).primaryKey().notNull(),
    canonicalName: text('canonical_name').notNull(),
    canonicalNameNormalized: text('canonical_name_normalized').notNull(),
    eosId: text('eos_id'),
    battleEyeGuid: text('battle_eye_guid'),
    lastKnownIp: inet('last_known_ip'),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    totalTimePlayedSeconds: bigint('total_time_played_seconds', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    eosIdUniqueIdx: uniqueIndex('players_eos_id_unique_idx')
      .on(table.eosId)
      .where(sql`eos_id IS NOT NULL`),
    canonicalNameNormalizedIdx: index('players_canonical_name_normalized_idx').on(
      table.canonicalNameNormalized,
    ),
    lastSeenAtIdx: index('players_last_seen_at_idx').on(table.lastSeenAt),
    roleIdIdx: index('players_role_id_idx')
      .on(table.roleId)
      .where(sql`role_id IS NOT NULL`),
  }),
);

export type PlayerRow = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
```

- [ ] **Step 4: Drop org_id from audit-log.ts**

`packages/db/src/schema/audit-log.ts` — remove the `orgId` column and any references. Read the current file, find:

```ts
orgId: uuid('org_id').references(() => organizations.id),
```

Delete that line and the `organizations` import.

- [ ] **Step 5: Create panel-meta.ts**

`packages/db/src/schema/panel-meta.ts`:

```ts
import { boolean, check, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const panelMeta = pgTable(
  'panel_meta',
  {
    id: smallint('id').primaryKey().default(1),
    firstOwnerClaimed: boolean('first_owner_claimed').notNull().default(false),
    rolesSeeded: boolean('roles_seeded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    singleton: check('panel_meta_singleton', sql`${table.id} = 1`),
  }),
);

export type PanelMetaRow = typeof panelMeta.$inferSelect;
```

- [ ] **Step 6: Update schema index**

`packages/db/src/schema/index.ts` — remove deleted exports, add `panel-meta`:

```ts
export * from './audit-log.js';
export * from './config-versions.js';
export * from './events.js';
export * from './panel-meta.js';
export * from './player-api-tokens.js';
export * from './player-ip-history.js';
export * from './player-name-history.js';
export * from './players.js';
export * from './role-permissions.js';
export * from './roles.js';
export * from './server-credentials.js';
export * from './server-settings.js';
export * from './servers.js';
export * from './sessions.js';
```

- [ ] **Step 7: Update seed index**

`packages/db/src/seed/index.ts` — drop the `seedSystemRoles` export. If the file only exported that, delete the file and remove the export from `packages/db/src/index.ts` if present.

- [ ] **Step 8: Typecheck the db package**

```bash
pnpm --filter @squad/db exec tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add packages/db/
git commit -m "refactor(db/schema): single-role + panel_meta, drop org/M:N/server-scopes"
```

---

## Task 3: shared-config — permission registry + role colors

**Files:**
- Modify: `packages/shared-config/src/permissions.ts`
- Create: `packages/shared-config/src/role-colors.ts`
- Modify: `packages/shared-config/src/index.ts`
- Create: `packages/shared-config/test/permissions.test.ts`
- Create: `packages/shared-config/test/role-colors.test.ts`

- [ ] **Step 1: Write the registry test (RED)**

`packages/shared-config/test/permissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_CATEGORIES,
  isPermissionKey,
  type PermissionDef,
} from '../src/permissions.js';

describe('PERMISSIONS registry', () => {
  it('keys are unique', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every category is declared in PERMISSION_CATEGORIES', () => {
    const cats = new Set<string>(PERMISSION_CATEGORIES);
    for (const p of PERMISSIONS) {
      expect(cats.has(p.category), `bad category for ${p.key}: ${p.category}`).toBe(true);
    }
  });

  it('dangerous and unimplemented are true | undefined (never false)', () => {
    for (const p of PERMISSIONS as PermissionDef[]) {
      if ('dangerous' in p) expect(p.dangerous).toBe(true);
      if ('unimplemented' in p) expect(p.unimplemented).toBe(true);
    }
  });

  it('every key has a non-empty label', () => {
    for (const p of PERMISSIONS) {
      expect(p.label, `empty label for ${p.key}`).toBeTruthy();
    }
  });

  it('PERMISSION_KEYS matches PERMISSIONS', () => {
    expect(PERMISSION_KEYS).toEqual(PERMISSIONS.map((p) => p.key));
  });

  it('isPermissionKey narrows correctly', () => {
    expect(isPermissionKey('server:view')).toBe(true);
    expect(isPermissionKey('not-a-key')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (must fail because old permissions.ts doesn't export PERMISSIONS yet)**

```bash
pnpm --filter @squad/shared-config exec vitest run test/permissions.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Rewrite permissions.ts with the registry**

`packages/shared-config/src/permissions.ts`:

```ts
export const PERMISSION_CATEGORIES = [
  'servers',
  'configs',
  'players',
  'moderation',
  'admin_groups',
  'whitelist',
  'host',
  'audit',
  'events',
  'users',
  'roles',
  'backup',
  'api_tokens',
  'discord',
  'triggers',
  'scheduler',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDef {
  readonly key: string;
  readonly category: PermissionCategory;
  readonly label: string;
  readonly dangerous?: true;
  readonly unimplemented?: true;
}

export const PERMISSIONS = [
  { key: 'server:view',          category: 'servers', label: 'Видеть серверы и их статус' },
  { key: 'server:install',       category: 'servers', label: 'Устанавливать серверы',          dangerous: true },
  { key: 'server:start',         category: 'servers', label: 'Start сервера' },
  { key: 'server:stop',          category: 'servers', label: 'Stop (graceful)' },
  { key: 'server:force_stop',    category: 'servers', label: 'Force-stop (kill)',              dangerous: true },
  { key: 'server:restart',       category: 'servers', label: 'Restart' },
  { key: 'server:delete',        category: 'servers', label: 'Удалить сервер с очисткой',       dangerous: true },
  { key: 'server:edit_settings', category: 'servers', label: 'Resource limits, ports, max_players' },
  { key: 'server:update',        category: 'servers', label: 'app_update через SteamCMD' },
  { key: 'config:view',          category: 'configs', label: 'Читать .cfg файлы' },
  { key: 'config:edit',          category: 'configs', label: 'Редактировать через Monaco' },
  { key: 'config:rollback',      category: 'configs', label: 'Откат к предыдущей версии' },
  { key: 'player:view',          category: 'players', label: 'Список игроков, ник, SteamID' },
  { key: 'player:view_ips',      category: 'players', label: 'История IP' },
  { key: 'player:view_notes',    category: 'players', label: 'Заметки про игрока',             unimplemented: true },
  { key: 'player:edit_notes',    category: 'players', label: 'Редактировать заметки',          unimplemented: true },
  { key: 'player:set_flags',     category: 'players', label: 'Custom теги (toxic, helpful)',   unimplemented: true },
  { key: 'mod:kick',             category: 'moderation', label: 'Kick через UI',     dangerous: true, unimplemented: true },
  { key: 'mod:warn',             category: 'moderation', label: 'Warn',                                unimplemented: true },
  { key: 'mod:ban_temp',         category: 'moderation', label: 'Temp ban',           dangerous: true, unimplemented: true },
  { key: 'mod:ban_perm',         category: 'moderation', label: 'Permanent ban',      dangerous: true, unimplemented: true },
  { key: 'mod:unban',            category: 'moderation', label: 'Unban',                               unimplemented: true },
  { key: 'admin_group:view',     category: 'admin_groups', label: 'Видеть Admins.cfg',   unimplemented: true },
  { key: 'admin_group:edit',     category: 'admin_groups', label: 'Редактировать Admins.cfg', unimplemented: true },
  { key: 'whitelist:view',       category: 'whitelist', label: 'Видеть whitelist',       unimplemented: true },
  { key: 'whitelist:edit',       category: 'whitelist', label: 'Управлять whitelist',    unimplemented: true },
  { key: 'host:view',            category: 'host', label: 'Dashboard host info' },
  { key: 'host:metrics',         category: 'host', label: 'Метрики (CPU/RAM/Disk/Net + история)' },
  { key: 'audit:view',           category: 'audit', label: 'Читать audit log' },
  { key: 'audit:export',         category: 'audit', label: 'Export audit в CSV', unimplemented: true },
  { key: 'events:view',          category: 'events', label: 'Game events log' },
  { key: 'user:view',            category: 'users', label: 'Список пользователей панели' },
  { key: 'user:manage_roles',    category: 'users', label: 'Назначать роли',  dangerous: true },
  { key: 'role:view',            category: 'roles', label: 'Видеть роли' },
  { key: 'role:create',          category: 'roles', label: 'Создавать роли' },
  { key: 'role:edit',            category: 'roles', label: 'Редактировать роли' },
  { key: 'role:delete',          category: 'roles', label: 'Удалять роли',    dangerous: true },
  { key: 'backup:view',          category: 'backup', label: 'Список backups',     unimplemented: true },
  { key: 'backup:trigger',       category: 'backup', label: 'Запустить backup',   unimplemented: true },
  { key: 'backup:restore',       category: 'backup', label: 'Restore из snapshot',dangerous: true, unimplemented: true },
  { key: 'api_token:create',     category: 'api_tokens', label: 'Создавать API tokens' },
  { key: 'api_token:revoke',     category: 'api_tokens', label: 'Ревокать tokens' },
  { key: 'discord:link',         category: 'discord', label: 'Привязать Discord', unimplemented: true },
  { key: 'trigger:view',         category: 'triggers',  label: 'Видеть авто-правила',     unimplemented: true },
  { key: 'trigger:edit',         category: 'triggers',  label: 'Редактировать авто-правила', unimplemented: true },
  { key: 'scheduler:view',       category: 'scheduler', label: 'Видеть запланированные задачи', unimplemented: true },
  { key: 'scheduler:edit',       category: 'scheduler', label: 'Редактировать расписание',     unimplemented: true },
] as const satisfies readonly PermissionDef[];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as readonly string[];
export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);
export function isPermissionKey(x: string): x is PermissionKey {
  return PERMISSION_KEY_SET.has(x);
}
```

- [ ] **Step 4: Run permissions test (GREEN)**

```bash
pnpm --filter @squad/shared-config exec vitest run test/permissions.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write role-colors test (RED)**

`packages/shared-config/test/role-colors.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_COLORS } from '../src/role-colors.js';

describe('ROLE_COLORS', () => {
  it('palette stays in sync with SQL CHECK constraint in 0009 migration', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../../packages/db/drizzle/0009_panel_rbac.sql'),
      'utf8',
    );
    const checkMatch = sql.match(
      /CONSTRAINT roles_color_palette CHECK \(\s*color IN \(([^)]+)\)/,
    );
    expect(checkMatch, 'CHECK constraint not found in migration').toBeTruthy();
    const sqlColors = checkMatch![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...ROLE_COLORS].sort()).toEqual([...sqlColors].sort());
  });

  it('has exactly 16 colors', () => {
    expect(ROLE_COLORS.length).toBe(16);
  });

  it('all entries are unique', () => {
    expect(new Set(ROLE_COLORS).size).toBe(ROLE_COLORS.length);
  });
});
```

- [ ] **Step 6: Run test (must fail — file doesn't exist)**

```bash
pnpm --filter @squad/shared-config exec vitest run test/role-colors.test.ts
```
Expected: FAIL with module-not-found.

- [ ] **Step 7: Create role-colors.ts**

`packages/shared-config/src/role-colors.ts`:

```ts
export const ROLE_COLORS = [
  'red', 'rose', 'pink', 'fuchsia', 'purple', 'violet', 'indigo', 'blue',
  'sky', 'cyan', 'teal', 'emerald', 'green', 'lime', 'amber', 'neutral',
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

export const ROLE_COLOR_SET: ReadonlySet<string> = new Set(ROLE_COLORS);
export function isRoleColor(x: string): x is RoleColor {
  return ROLE_COLOR_SET.has(x);
}
```

- [ ] **Step 8: Run role-colors test (GREEN)**

```bash
pnpm --filter @squad/shared-config exec vitest run test/role-colors.test.ts
```
Expected: PASS.

- [ ] **Step 9: Update package barrel**

`packages/shared-config/src/index.ts` — drop `ROLE_CLEARANCE`, `SYSTEM_ROLE_CLEARANCE`, `RoleName`, `SYSTEM_ROLE_PERMISSIONS` exports (sider lives in SQL now). Add `role-colors`. Read current file and remove obsolete re-exports; add:

```ts
export * from './role-colors.js';
```

- [ ] **Step 10: Typecheck**

```bash
pnpm --filter @squad/shared-config exec tsc --noEmit
pnpm turbo run typecheck
```
Expected: shared-config 0 errors. Other packages may break — that's fine, they get fixed in Tasks 4-9.

- [ ] **Step 11: Commit**

```bash
git add packages/shared-config/
git commit -m "feat(shared-config): permission registry objects + 16-color role palette"
```

---

## Task 4: Refactor lib/rbac.ts — single-role + per-role invalidation

**Files:**
- Modify: `apps/api/src/lib/rbac.ts`
- Modify: `apps/api/src/plugins/auth.ts` (PermissionContext shape no longer carries clearance)
- Modify: `apps/api/src/lib/api-tokens.ts` if it uses clearance (audit and remove if so)

- [ ] **Step 1: Rewrite rbac.ts**

`apps/api/src/lib/rbac.ts`:

```ts
import type { DatabaseClient } from '@squad/db';
import { players, rolePermissions } from '@squad/db/schema';
import type { PermissionKey } from '@squad/shared-config';
import { eq } from 'drizzle-orm';

export interface PermissionContext {
  permissions: Set<PermissionKey>;
  roleId: string | null;
}

const cache = new Map<string, { value: PermissionContext; expiresAt: number }>();
const TTL_MS = 30_000;

export async function loadUserPermissions(
  db: DatabaseClient,
  steamId64: bigint,
): Promise<PermissionContext> {
  const cacheKey = String(steamId64);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const playerRows = await db
    .select({ roleId: players.roleId })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  const roleId = playerRows[0]?.roleId ?? null;

  if (!roleId) {
    const empty: PermissionContext = { permissions: new Set(), roleId: null };
    cache.set(cacheKey, { value: empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  const perms = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));

  const permissions = new Set(perms.map((p) => p.key as PermissionKey));
  const value: PermissionContext = { permissions, roleId };
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidatePermissionCache(steamId64: bigint): void {
  cache.delete(String(steamId64));
}

export async function invalidatePermissionCacheForRole(
  db: DatabaseClient,
  roleId: string,
): Promise<void> {
  const rows = await db
    .select({ steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.roleId, roleId));
  for (const r of rows) cache.delete(String(r.steamId64));
}

export function hasPermission(ctx: PermissionContext, required: readonly PermissionKey[]): boolean {
  for (const key of required) if (!ctx.permissions.has(key)) return false;
  return true;
}
```

- [ ] **Step 2: Update auth plugin to drop `clearance`**

`apps/api/src/plugins/auth.ts` — find the two places where `PermissionContext` is constructed (cookie path and bearer path) and remove `clearance:` and `roleIds:` properties; change `req.user.permissions` shape. The `intersectScopes` call returns a `Set<PermissionKey>`; wrap into `{ permissions: effective, roleId: rolePerms.roleId }`.

Also the `hasServerPermission` import (if any) goes away.

Check `apps/api/src/types/fastify.d.ts` (or wherever `req.user` is declared) and update its `permissions` field type to match the new `PermissionContext`.

- [ ] **Step 3: Search and patch other consumers**

```bash
grep -rn "clearance" apps/api/src/ packages/
```

Expected hits: any `.clearance` access on `PermissionContext`. Remove them all. If a route used clearance for ordering/filtering (search log shows none), refactor accordingly.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @squad/api exec tsc --noEmit
```
Expected: 0 errors related to the new types. Other failures (route files) get fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/rbac.ts apps/api/src/plugins/auth.ts apps/api/src/types/
git commit -m "refactor(api/rbac): single-role lookup + invalidatePermissionCacheForRole"
```

---

## Task 5: Refactor first-owner.ts to panel_meta

**Files:**
- Modify: `apps/api/src/lib/first-owner.ts`
- Modify: `apps/api/test/first-owner.test.ts`

- [ ] **Step 1: Update test fixture for panel_meta-based logic (RED)**

Open `apps/api/test/first-owner.test.ts`. Replace the org-based fixture setup with `panel_meta`-based: insert into `panel_meta`, `roles`, `players`, then call `claimFirstOwner`. Assert:
1. First call returns `'claimed'`, sets `players.role_id`, sets `panel_meta.first_owner_claimed=true`.
2. Second call returns `'already_claimed'`.
3. Concurrent calls (two parallel transactions) yield exactly one `'claimed'` (advisory lock).
4. If sentinel-file present (bridge.fileRead succeeds) → `'already_claimed'` without DB write.

Sample core test:

```ts
it('claims Owner once and sets the singleton flag', async () => {
  const result = await claimFirstOwner(db, fakeBridge, 76561198000000001n);
  expect(result).toBe('claimed');
  const p = await db.select().from(players).where(eq(players.steamId64, 76561198000000001n));
  expect(p[0].roleId).toBe(ownerRoleId);
  const meta = await db.select().from(panelMeta).where(eq(panelMeta.id, 1));
  expect(meta[0].firstOwnerClaimed).toBe(true);
});
```

- [ ] **Step 2: Run test (must fail — old logic uses orgs)**

```bash
pnpm --filter @squad/api exec vitest run test/first-owner.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Rewrite first-owner.ts**

`apps/api/src/lib/first-owner.ts`:

```ts
import type { DatabaseClient } from '@squad/db';
import { panelMeta, players, roles } from '@squad/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export type ClaimResult = 'claimed' | 'already_claimed' | 'no_owner_role';

export interface SentinelBridge {
  fileRead(args: { path: string }): Promise<unknown>;
  fileAtomicWrite(args: { path: string; content: string; mode?: number }): Promise<unknown>;
}

const SENTINEL_PATH = '/var/lib/squad-panel/.first-owner-claimed';

export async function claimFirstOwner(
  db: DatabaseClient,
  bridge: SentinelBridge,
  steamId64: bigint,
): Promise<ClaimResult> {
  try {
    await bridge.fileRead({ path: SENTINEL_PATH });
    return 'already_claimed';
  } catch {
    // sentinel absent or bridge error — proceed to DB-anchored path
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('panel_first_owner'))`);

    const meta = await tx.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    if (meta[0]?.firstOwnerClaimed) return 'already_claimed' as const;

    const ownerRoleRows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerRoleId = ownerRoleRows[0]?.id;
    if (!ownerRoleId) return 'no_owner_role' as const;

    const ownerExists = await tx
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.roleId, ownerRoleId))
      .limit(1);
    if (ownerExists.length > 0) {
      await tx.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));
      return 'already_claimed' as const;
    }

    await tx.update(players).set({ roleId: ownerRoleId }).where(eq(players.steamId64, steamId64));
    await tx.update(panelMeta).set({ firstOwnerClaimed: true }).where(eq(panelMeta.id, 1));
    return 'claimed' as const;
  });

  if (result === 'claimed') {
    try {
      await bridge.fileAtomicWrite({
        path: SENTINEL_PATH,
        content: JSON.stringify({
          steam_id64: String(steamId64),
          claimed_at: new Date().toISOString(),
        }),
      });
    } catch {
      // sentinel write failure is non-fatal — DB is the source of truth.
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test (GREEN)**

```bash
pnpm --filter @squad/api exec vitest run test/first-owner.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/first-owner.ts apps/api/test/first-owner.test.ts
git commit -m "refactor(api/first-owner): panel_meta-based claim, players.role_id update"
```

---

## Task 6: Permission rename across existing routes + audit-coverage update

**Files:**
- Modify: every `apps/api/src/routes/*.ts` that uses old permission keys
- Create: `apps/api/test/permission-rename-coverage.test.ts`
- Modify: `apps/api/test/audit-coverage.test.ts`

- [ ] **Step 1: Write the rename-coverage test (RED)**

`apps/api/test/permission-rename-coverage.test.ts`:

```ts
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'server:create',
  'server:edit',
  'server:config:write',
  'server:config:history',
  'player:view_eos_id',
  'player:view_steam_id',
  'user:create',
  'user:edit',
  'user:delete',
  'role:manage',
  'permission:manage',
  'host:bridge_control',
  'org:view',
  'org:edit',
];

describe('permission key renames', () => {
  for (const key of FORBIDDEN) {
    it(`no remaining references to "${key}"`, () => {
      const result = execSync(
        `grep -rn -F "'${key}'" apps/api/src/ apps/web/src/ packages/ || true`,
        { encoding: 'utf8' },
      );
      expect(result.trim(), `stale references to ${key}:\n${result}`).toBe('');
    });
  }
});
```

- [ ] **Step 2: Run test — expect failures**

```bash
pnpm --filter @squad/api exec vitest run test/permission-rename-coverage.test.ts
```
Expected: lots of FAIL lines listing stale references.

- [ ] **Step 3: Map renames in routes**

Apply this mapping with `sed` per file (or manually with Edit) to every route file in `apps/api/src/routes/`:

| Old | New |
|---|---|
| `'server:create'` | (drop the route or merge — `POST /servers` is the install path; should require `'server:install'`) |
| `'server:edit'` | `'server:edit_settings'` |
| `'server:config:write'` | `'config:edit'` |
| `'server:config:history'` | `'config:rollback'` (and add `'config:view'` to GET routes that read .cfg) |
| `'player:view_eos_id'` | drop — covered by `'player:view'` |
| `'player:view_steam_id'` | drop — covered by `'player:view'` |
| `'user:create'`/`'user:edit'`/`'user:delete'` | drop |
| `'role:manage'` | `'role:edit'` (or split per route) |
| `'permission:manage'` | drop |
| `'host:bridge_control'` | drop |
| `'org:view'`/`'org:edit'` | drop |

For each file, read it, identify each `permissions: [...]` array in `config`, and apply the mapping. Be careful: `server-configs.ts` has both read (config:view) and write (config:edit) routes — read its current content carefully.

- [ ] **Step 4: Run rename-coverage test (GREEN)**

```bash
pnpm --filter @squad/api exec vitest run test/permission-rename-coverage.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update audit-coverage.test.ts plugin imports**

In `apps/api/test/audit-coverage.test.ts`, the `collectRoutes()` function imports route plugins. We will:
- Remove `setupRoutes` (deleted in Task 8).
- Add (later, after Task 7) `permissionsRoutes`, `rolesRoutes`, `usersRoutes`.

For now, just remove `setupRoutes` import and call. Re-add new ones in their respective tasks.

- [ ] **Step 6: Run full api test suite**

```bash
pnpm --filter @squad/api test
```
Expected: rename-coverage passes, no other regressions caused by this commit (some pre-existing tests may still fail because of broken consumers; we fix them in tasks 7-9).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ apps/api/test/permission-rename-coverage.test.ts apps/api/test/audit-coverage.test.ts
git commit -m "refactor(api/routes): rename permission keys to new registry"
```

---

## Task 7: New routes — permissions, roles, users, players role

**Files:**
- Create: `apps/api/src/routes/permissions.ts`
- Create: `apps/api/src/routes/roles.ts`
- Create: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/routes/players.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/test/permissions-list.test.ts`
- Create: `apps/api/test/roles-crud.test.ts`
- Create: `apps/api/test/users-list.test.ts`
- Create: `apps/api/test/player-role-assign.test.ts`
- Delete: `apps/api/test/players-roles.test.ts`

### 7.1 GET /api/v1/permissions

- [ ] **Step 1: Write integration test (RED)**

`apps/api/test/permissions-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@squad/shared-config';
import { withApp, asUser } from './helpers/integration.js';

describe('GET /api/v1/permissions', () => {
  it('returns the registry to a user with role:view', async () => {
    await withApp(async (app, ctx) => {
      const res = await asUser(app, ctx.viewerSession).inject({
        method: 'GET',
        url: '/api/v1/permissions',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ key: string }>;
      expect(body.length).toBe(PERMISSIONS.length);
      expect(body.find((p) => p.key === 'server:view')).toBeTruthy();
    });
  });

  it('rejects users without role:view (403)', async () => {
    await withApp(async (app, ctx) => {
      const res = await asUser(app, ctx.noRoleSession).inject({
        method: 'GET',
        url: '/api/v1/permissions',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
```

(`withApp` and `asUser` are existing test fixtures; if `ctx.viewerSession` doesn't exist, add it to `apps/api/test/helpers/integration.ts` — Viewer has `role:view` per Task 1 seed.)

- [ ] **Step 2: Run test (must fail — route doesn't exist)**

```bash
pnpm --filter @squad/api exec vitest run test/permissions-list.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/permissions.ts`:

```ts
import { PERMISSIONS } from '@squad/shared-config';
import type { FastifyPluginAsync } from 'fastify';

const permissionsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/permissions',
    { config: { permissions: ['role:view'], audit: false } },
    async () => PERMISSIONS,
  );
};

export default permissionsRoutes;
```

Register in `apps/api/src/server.ts` next to other route imports.

- [ ] **Step 4: Run test (GREEN)**

```bash
pnpm --filter @squad/api exec vitest run test/permissions-list.test.ts
```
Expected: PASS.

### 7.2 CRUD /api/v1/roles

- [ ] **Step 5: Write CRUD test (RED)**

`apps/api/test/roles-crud.test.ts` — cover:
- `POST /api/v1/roles` 201 with body `{name, color, description?, permissions: []}`.
- `POST` 409 on duplicate name.
- `GET /api/v1/roles` returns all roles with `assigned_users_count`.
- `GET /api/v1/roles/:id` 200 / 404.
- `PUT /api/v1/roles/:id` updates name/color/permissions; cache invalidation for affected users.
- `PUT` 400 when target is `name='Owner' AND is_system_role=true`.
- `DELETE /api/v1/roles/:id` cascades `players.role_id = NULL`.
- `DELETE` 400 for Owner.
- All mutating ops require `role:create` / `role:edit` / `role:delete` respectively.
- Audit entries written for each mutation.

Sample assertion for the cache-invalidation case:

```ts
it('PUT removes a permission and the user loses access immediately', async () => {
  await withApp(async (app, ctx) => {
    const role = await createRole(app, { name: 'Test', color: 'blue', permissions: ['server:view'] });
    await assignRole(app, ctx.secondaryPlayer.steamId64, role.id);
    let res = await asUser(app, ctx.secondarySession).inject({ method: 'GET', url: '/api/v1/servers' });
    expect(res.statusCode).toBe(200);

    await asUser(app, ctx.ownerSession).inject({
      method: 'PUT', url: `/api/v1/roles/${role.id}`,
      payload: { permissions: [] },
    });

    res = await asUser(app, ctx.secondarySession).inject({ method: 'GET', url: '/api/v1/servers' });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 6: Run test (must fail — no routes)**

```bash
pnpm --filter @squad/api exec vitest run test/roles-crud.test.ts
```
Expected: FAIL.

- [ ] **Step 7: Implement /api/v1/roles**

`apps/api/src/routes/roles.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { isPermissionKey, isRoleColor, PERMISSIONS } from '@squad/shared-config';
import { invalidatePermissionCacheForRole } from '../lib/rbac.js';

const colorSchema = z.string().refine(isRoleColor, { message: 'invalid color' });
const permissionsArraySchema = z
  .array(z.string().refine(isPermissionKey, { message: 'unknown permission key' }))
  .max(PERMISSIONS.length);

const createBody = z.object({
  name: z.string().min(1).max(64),
  color: colorSchema,
  description: z.string().max(256).optional(),
  permissions: permissionsArraySchema,
});

const updateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  color: colorSchema.optional(),
  description: z.string().max(256).nullable().optional(),
  permissions: permissionsArraySchema.optional(),
});

const idParam = z.object({ id: z.string().uuid() });

async function listRolesWithCounts(db: import('@squad/db').DatabaseClient) {
  const rows = await db.execute<{
    id: string;
    name: string;
    color: string;
    description: string | null;
    is_system_role: boolean;
    permissions: string[];
    assigned_users_count: number;
  }>(sql`
    SELECT r.id, r.name, r.color, r.description, r.is_system_role,
      COALESCE(
        (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
         FROM role_permissions rp WHERE rp.role_id = r.id), ARRAY[]::text[]
      ) AS permissions,
      (SELECT count(*)::int FROM players p WHERE p.role_id = r.id) AS assigned_users_count
    FROM roles r
    ORDER BY r.is_system_role DESC, r.name ASC
  `);
  return rows.rows ?? rows;
}

const rolesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get('/api/v1/roles', { config: { permissions: ['role:view'], audit: false } }, async () => {
    return await listRolesWithCounts(app.db);
  });

  fast.get(
    '/api/v1/roles/:id',
    { schema: { params: idParam }, config: { permissions: ['role:view'], audit: false } },
    async (req, reply) => {
      const all = (await listRolesWithCounts(app.db)) as Array<{ id: string }>;
      const found = all.find((r) => r.id === req.params.id);
      if (!found) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      return found;
    },
  );

  fast.post(
    '/api/v1/roles',
    {
      schema: { body: createBody },
      config: { permissions: ['role:create'], audit: { action: 'role.create', resource: 'role' } },
    },
    async (req, reply) => {
      const id = uuidv7();
      try {
        await app.db.transaction(async (tx) => {
          await tx.insert(roles).values({
            id,
            name: req.body.name,
            color: req.body.color,
            description: req.body.description ?? null,
            isSystemRole: false,
          });
          if (req.body.permissions.length) {
            await tx.insert(rolePermissions).values(
              req.body.permissions.map((permissionKey) => ({ roleId: id, permissionKey })),
            );
          }
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      reply.code(201);
      const fresh = (await listRolesWithCounts(app.db)) as Array<{ id: string }>;
      return fresh.find((r) => r.id === id);
    },
  );

  fast.put(
    '/api/v1/roles/:id',
    {
      schema: { params: idParam, body: updateBody },
      config: { permissions: ['role:edit'], audit: { action: 'role.update', resource: 'role' } },
    },
    async (req, reply) => {
      const target = await app.db.select().from(roles).where(eq(roles.id, req.params.id)).limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      if (target[0].isSystemRole && target[0].name === 'Owner') {
        reply.code(400);
        return { error: 'owner_role_immutable' };
      }
      try {
        await app.db.transaction(async (tx) => {
          const updates: Partial<typeof roles.$inferInsert> = {};
          if (req.body.name !== undefined) updates.name = req.body.name;
          if (req.body.color !== undefined) updates.color = req.body.color;
          if (req.body.description !== undefined)
            updates.description = req.body.description;
          if (Object.keys(updates).length > 0) {
            await tx.update(roles).set(updates).where(eq(roles.id, req.params.id));
          }
          if (req.body.permissions !== undefined) {
            await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, req.params.id));
            if (req.body.permissions.length > 0) {
              await tx
                .insert(rolePermissions)
                .values(
                  req.body.permissions.map((permissionKey) => ({
                    roleId: req.params.id,
                    permissionKey,
                  })),
                );
            }
          }
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          reply.code(409);
          return { error: 'role_name_taken' };
        }
        throw err;
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      const fresh = (await listRolesWithCounts(app.db)) as Array<{ id: string }>;
      return fresh.find((r) => r.id === req.params.id);
    },
  );

  fast.delete(
    '/api/v1/roles/:id',
    {
      schema: { params: idParam },
      config: { permissions: ['role:delete'], audit: { action: 'role.delete', resource: 'role' } },
    },
    async (req, reply) => {
      const target = await app.db.select().from(roles).where(eq(roles.id, req.params.id)).limit(1);
      if (target.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
      if (target[0].isSystemRole && target[0].name === 'Owner') {
        reply.code(400);
        return { error: 'owner_role_immutable' };
      }
      await invalidatePermissionCacheForRole(app.db, req.params.id);
      await app.db.delete(roles).where(eq(roles.id, req.params.id));
      return { ok: true };
    },
  );
};

export default rolesRoutes;
```

Register in `server.ts`.

- [ ] **Step 8: Run roles-crud test (GREEN)**

```bash
pnpm --filter @squad/api exec vitest run test/roles-crud.test.ts
```
Expected: PASS.

### 7.3 GET /api/v1/users + PUT /api/v1/players/:steamId/role

- [ ] **Step 9: Delete the old M:N test**

```bash
rm apps/api/test/players-roles.test.ts
```

- [ ] **Step 10: Write users-list test (RED)**

`apps/api/test/users-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withApp, asUser } from './helpers/integration.js';

describe('GET /api/v1/users', () => {
  it('lists only players with role_id NOT NULL', async () => {
    await withApp(async (app, ctx) => {
      const res = await asUser(app, ctx.ownerSession).inject({
        method: 'GET',
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ steam_id64: string; role: { name: string } }>;
      expect(body.find((u) => u.steam_id64 === String(ctx.ownerSteamId))).toBeTruthy();
      expect(body.find((u) => u.steam_id64 === String(ctx.noRoleSteamId))).toBeFalsy();
    });
  });
});
```

- [ ] **Step 11: Write player-role-assign test (RED)**

`apps/api/test/player-role-assign.test.ts` — cover:
- `GET /api/v1/players/:steamId/role` returns current role or null.
- `PUT /api/v1/players/:steamId/role` with `{role_id: <viewer>}` 200; `GET` reflects.
- `PUT` with `{role_id: null}` clears.
- `PUT` with non-existent role_id → 404.
- Owner-lockout: only-Owner cannot have role removed → 409 `cannot_remove_last_owner`.
- Owner-lockout: only-Owner cannot be changed to a non-Owner role → 409.
- Cache invalidation: after PUT, immediate request reflects new permissions.

- [ ] **Step 12: Run tests (must fail)**

```bash
pnpm --filter @squad/api exec vitest run test/users-list.test.ts test/player-role-assign.test.ts
```
Expected: FAIL.

- [ ] **Step 13: Implement /api/v1/users**

`apps/api/src/routes/users.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/users',
    { config: { permissions: ['user:view'], audit: false } },
    async () => {
      const rows = await app.db.execute<{
        steam_id64: string;
        canonical_name: string;
        last_seen_at: string;
        role_id: string;
        role_name: string;
        role_color: string;
        role_is_system: boolean;
        assigned_at: string | null;
        assigned_by: string | null;
      }>(sql`
        SELECT p.steam_id64::text AS steam_id64, p.canonical_name, p.last_seen_at,
               r.id AS role_id, r.name AS role_name, r.color AS role_color,
               r.is_system_role AS role_is_system,
               NULL::timestamptz AS assigned_at, NULL::text AS assigned_by
        FROM players p
        JOIN roles r ON r.id = p.role_id
        WHERE p.role_id IS NOT NULL
        ORDER BY p.last_seen_at DESC
      `);
      const items = (rows.rows ?? rows) as Array<Record<string, unknown>>;
      return items.map((r) => ({
        steam_id64: r.steam_id64,
        canonical_name: r.canonical_name,
        last_seen_at: r.last_seen_at,
        role: {
          id: r.role_id,
          name: r.role_name,
          color: r.role_color,
          is_system_role: r.role_is_system,
        },
        assigned_at: r.assigned_at,
        assigned_by: r.assigned_by,
      }));
    },
  );
};

export default usersRoutes;
```

(Note: `assigned_at` / `assigned_by` are NULL in this iteration. Adding them properly requires schema changes — open follow-up: future enhancement to record assignment metadata on `players` directly with `role_assigned_at`, `role_assigned_by` columns. For Эпик 2 P0 this is acceptable; UI shows "—".)

Register in `server.ts`.

- [ ] **Step 14: Update apps/api/src/routes/players.ts**

In players.ts, replace the M:N endpoints with single-role versions. Read the current file, then:

Delete:
- `GET /api/v1/players/:steamId/roles`
- `POST /api/v1/players/:steamId/roles`
- `DELETE /api/v1/players/:steamId/roles/:roleId`

Add:

```ts
fast.get(
  '/api/v1/players/:steamId/role',
  { config: { permissions: ['user:view'], audit: false }, schema: { params: playerIdParams } },
  async (req) => {
    const id = BigInt(req.params.steamId);
    const rows = await app.db.execute<{
      role_id: string | null;
      role_name: string | null;
      role_color: string | null;
      role_is_system: boolean | null;
    }>(sql`
      SELECT r.id AS role_id, r.name AS role_name, r.color AS role_color,
             r.is_system_role AS role_is_system
      FROM players p LEFT JOIN roles r ON r.id = p.role_id
      WHERE p.steam_id64 = ${id}
    `);
    const r = (rows.rows ?? rows)[0];
    if (!r || !r.role_id) return { role: null };
    return {
      role: {
        id: r.role_id,
        name: r.role_name,
        color: r.role_color,
        is_system_role: r.role_is_system,
      },
    };
  },
);

const roleAssignBody = z.object({ role_id: z.string().uuid().nullable() });

fast.put(
  '/api/v1/players/:steamId/role',
  {
    schema: { params: playerIdParams, body: roleAssignBody },
    config: {
      permissions: ['user:manage_roles'],
      audit: { action: 'player.role.assign', resource: 'player' },
    },
  },
  async (req, reply) => {
    const steamId64 = BigInt(req.params.steamId);
    const newRoleId = req.body.role_id;

    if (newRoleId !== null) {
      const exists = await app.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, newRoleId))
        .limit(1);
      if (exists.length === 0) {
        reply.code(404);
        return { error: 'role_not_found' };
      }
    }

    // Owner-lockout invariant: when the change would leave ≥0 Owners, reject.
    const ownerRow = await app.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
      .limit(1);
    const ownerId = ownerRow[0]?.id ?? null;

    const current = await app.db
      .select({ roleId: players.roleId })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    const wasOwner = current[0]?.roleId === ownerId && ownerId !== null;
    const willBeOwner = newRoleId === ownerId && ownerId !== null;
    if (wasOwner && !willBeOwner) {
      const ownerCount = await app.db
        .select({ c: sql<number>`count(*)::int` })
        .from(players)
        .where(eq(players.roleId, ownerId!));
      if ((ownerCount[0]?.c ?? 0) <= 1) {
        reply.code(409);
        return { error: 'cannot_remove_last_owner' };
      }
    }

    await app.db.update(players).set({ roleId: newRoleId }).where(eq(players.steamId64, steamId64));
    invalidatePermissionCache(steamId64);
    return { ok: true };
  },
);
```

Add the imports at top of `players.ts`: `import { invalidatePermissionCache } from '../lib/rbac.js'; import { and, sql } from 'drizzle-orm';`. The existing `roles` import stays.

- [ ] **Step 15: Update GET /api/v1/roles drop in players.ts**

The legacy `/api/v1/roles` endpoint already exists in `players.ts` — remove it (lives in `roles.ts` now).

- [ ] **Step 16: Run tests**

```bash
pnpm --filter @squad/api exec vitest run test/users-list.test.ts test/player-role-assign.test.ts
```
Expected: PASS.

- [ ] **Step 17: Update audit-coverage test plugin imports**

In `apps/api/test/audit-coverage.test.ts`, add imports + register calls:

```ts
import permissionsRoutes from '../src/routes/permissions.js';
import rolesRoutes from '../src/routes/roles.js';
import usersRoutes from '../src/routes/users.js';
```

Register them in the `collectRoutes()` setup alongside the others.

- [ ] **Step 18: Run audit-coverage test**

```bash
pnpm --filter @squad/api exec vitest run test/audit-coverage.test.ts
```
Expected: PASS.

- [ ] **Step 19: Run full api test suite**

```bash
pnpm --filter @squad/api test
```
Expected: PASS.

- [ ] **Step 20: Commit**

```bash
git add apps/api/src/routes/ apps/api/src/server.ts apps/api/test/
git commit -m "feat(api): permissions/roles/users CRUD, single-role assign, drop M:N players-roles"
```

---

## Task 8: First-login Owner trick on Steam-callback + drop /setup

**Files:**
- Modify: `apps/api/src/routes/auth-steam.ts`
- Delete: `apps/api/src/routes/setup.ts`
- Modify: `apps/api/src/server.ts` (drop setup registration)
- Delete: `apps/api/test/setup.test.ts`
- Create: `apps/api/test/setup-removed.test.ts`

- [ ] **Step 1: Write setup-removed test (RED)**

`apps/api/test/setup-removed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withApp } from './helpers/integration.js';

describe('setup wizard removed', () => {
  it('GET /api/v1/setup/check-env returns 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
      expect(res.statusCode).toBe(404);
    });
  });
  it('POST /api/v1/setup/init returns 404', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/init',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Run test (must fail — routes still exist)**

```bash
pnpm --filter @squad/api exec vitest run test/setup-removed.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Delete setup route and test**

```bash
rm apps/api/src/routes/setup.ts
rm apps/api/test/setup.test.ts
```

- [ ] **Step 4: Update server.ts**

Remove the import and `app.register(setupRoutes)` call.

- [ ] **Step 5: Audit-coverage test cleanup**

`apps/api/test/audit-coverage.test.ts` — remove the `setupRoutes` import + register call (already done in Task 6 if you followed it).

- [ ] **Step 6: Verify auth-steam.ts already calls claimFirstOwner**

Re-read `apps/api/src/routes/auth-steam.ts:115`. After Task 5, `claimFirstOwner` is panel_meta-based. Confirm the call site doesn't reference the old org-based interface. The `req.log.error('Owner role missing — system roles not seeded?')` branch should still exist.

The body of the callback **already** does what the spec wants: insert the player → call claimFirstOwner → load permissions → if zero, redirect to /no-access; else create session. No changes needed beyond Task 5.

- [ ] **Step 7: Run setup-removed + auth-steam tests**

```bash
pnpm --filter @squad/api exec vitest run test/setup-removed.test.ts test/auth-steam.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/
git commit -m "refactor(api/auth): drop /setup wizard, first-owner trick stays on Steam callback"
```

---

## Task 9: E2E test — full RBAC lifecycle

**Files:**
- Create: `apps/api/test/e2e/panel-rbac.e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

`apps/api/test/e2e/panel-rbac.e2e.test.ts` — drives the live panel via HTTPS using `PANEL_TEST_URL` + `PANEL_TEST_COOKIE` (same env conventions as `install-lifecycle.e2e.test.ts`):

```ts
import { describe, expect, it } from 'vitest';

const URL = process.env.PANEL_TEST_URL!;
const COOKIE = process.env.PANEL_TEST_COOKIE!;

const SECONDARY_STEAM_ID = process.env.PANEL_E2E_SECONDARY_STEAM_ID!;
// PANEL_E2E_SECONDARY_STEAM_ID — a SteamID64 that has been seen by log-ingest
// (i.e. a row in `players`) but has no role yet.

const fetchOwner = (path: string, init: RequestInit = {}) =>
  fetch(`${URL}${path}`, {
    ...init,
    headers: { ...init.headers, cookie: `__Host-sid=${COOKIE}` },
  });

describe('panel RBAC e2e', () => {
  it('full lifecycle: create role → assign → modify → revoke', async () => {
    // 1. Create role
    let res = await fetchOwner('/api/v1/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `E2E_${Date.now()}`,
        color: 'blue',
        permissions: ['server:view'],
      }),
    });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { id: string };

    // 2. Assign
    res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: role.id }),
    });
    expect(res.status).toBe(200);

    // 3. Verify role is set
    res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
    expect(res.status).toBe(200);
    const r = (await res.json()) as { role: { id: string } | null };
    expect(r.role?.id).toBe(role.id);

    // 4. Modify role permissions
    res = await fetchOwner(`/api/v1/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: [] }),
    });
    expect(res.status).toBe(200);

    // 5. Delete role
    res = await fetchOwner(`/api/v1/roles/${role.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // 6. Verify cascade — secondary now has no role
    res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
    const after = (await res.json()) as { role: null };
    expect(after.role).toBeNull();
  });

  it('Owner-lockout: cannot remove last Owner', async () => {
    const meRes = await fetchOwner('/api/v1/me');
    const me = (await meRes.json()) as { steam_id64: string };
    const res = await fetchOwner(`/api/v1/players/${me.steam_id64}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: null }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cannot_remove_last_owner');
  });
});
```

- [ ] **Step 2: Verify it does NOT run in default test (excluded by vitest.e2e.config)**

```bash
pnpm --filter @squad/api test
```
Expected: PASS, e2e file not picked up.

- [ ] **Step 3: Run e2e against live stack** (manual: requires panel up, env set)

```bash
PANEL_TEST_URL=https://squad-panel.lan PANEL_TEST_COOKIE=… PANEL_E2E_SECONDARY_STEAM_ID=… pnpm --filter @squad/api test:e2e
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/e2e/panel-rbac.e2e.test.ts
git commit -m "test(api/e2e): panel RBAC full lifecycle"
```

---

## Task 10: Web — RoleColorDot component + nav update

**Files:**
- Create: `apps/web/src/components/RoleColorDot.tsx`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Create RoleColorDot**

`apps/web/src/components/RoleColorDot.tsx`:

```tsx
import type { RoleColor } from '@squad/shared-config';

const CLASS_MAP: Record<RoleColor, string> = {
  red: 'bg-red-500',
  rose: 'bg-rose-500',
  pink: 'bg-pink-500',
  fuchsia: 'bg-fuchsia-500',
  purple: 'bg-purple-500',
  violet: 'bg-violet-500',
  indigo: 'bg-indigo-500',
  blue: 'bg-blue-500',
  sky: 'bg-sky-500',
  cyan: 'bg-cyan-500',
  teal: 'bg-teal-500',
  emerald: 'bg-emerald-500',
  green: 'bg-green-500',
  lime: 'bg-lime-500',
  amber: 'bg-amber-500',
  neutral: 'bg-neutral-500',
};

export function RoleColorDot({ color, size = 'md' }: { color: RoleColor; size?: 'sm' | 'md' }) {
  const cls = CLASS_MAP[color] ?? 'bg-neutral-500';
  const dim = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  return <span className={`inline-block rounded-full ${dim} ${cls}`} aria-hidden />;
}
```

- [ ] **Step 2: Update dashboard nav**

`apps/web/src/app/(dashboard)/layout.tsx` — find the Link list, add two entries (gated by permissions on `me`):

```tsx
{me.permissions.includes('role:view') ? (
  <Link href="/roles" className="block rounded px-2 py-1 hover:bg-neutral-900">
    Роли
  </Link>
) : null}
{me.permissions.includes('user:view') ? (
  <Link href="/users" className="block rounded px-2 py-1 hover:bg-neutral-900">
    Пользователи
  </Link>
) : null}
```

Insert them after the existing `Игроки` link.

- [ ] **Step 3: Build + smoke**

```bash
pnpm --filter @squad/web build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/RoleColorDot.tsx apps/web/src/app/\(dashboard\)/layout.tsx
git commit -m "feat(web): RoleColorDot + nav links for /roles and /users"
```

---

## Task 11: Web — /roles list page + RoleEditor + create/edit pages

**Files:**
- Create: `apps/web/src/components/RoleEditor.tsx`
- Create: `apps/web/src/app/(dashboard)/roles/page.tsx`
- Create: `apps/web/src/app/(dashboard)/roles/new/page.tsx`
- Create: `apps/web/src/app/(dashboard)/roles/[id]/page.tsx`

- [ ] **Step 1: Create RoleEditor component**

`apps/web/src/components/RoleEditor.tsx`:

```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { ROLE_COLORS, type RoleColor } from '@squad/shared-config';
import { RoleColorDot } from './RoleColorDot';

interface PermissionDef {
  key: string;
  category: string;
  label: string;
  dangerous?: true;
  unimplemented?: true;
}

interface RoleEditorProps {
  initial?: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
    isSystemRole?: boolean;
    isOwner?: boolean;
  };
  onSubmit: (data: {
    name: string;
    color: RoleColor;
    description: string | null;
    permissions: string[];
  }) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}

const CATEGORY_ORDER: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'servers',      label: 'Серверы' },
  { id: 'configs',      label: 'Конфиги' },
  { id: 'players',      label: 'Игроки' },
  { id: 'moderation',   label: 'Модерация' },
  { id: 'admin_groups', label: 'Squad-группы' },
  { id: 'whitelist',    label: 'Whitelist' },
  { id: 'host',         label: 'Хост' },
  { id: 'audit',        label: 'Журнал' },
  { id: 'events',       label: 'События' },
  { id: 'users',        label: 'Пользователи' },
  { id: 'roles',        label: 'Роли' },
  { id: 'backup',       label: 'Backup' },
  { id: 'api_tokens',   label: 'API-токены' },
  { id: 'discord',      label: 'Discord' },
  { id: 'triggers',     label: 'Триггеры' },
  { id: 'scheduler',    label: 'Расписание' },
];

export function RoleEditor({ initial, onSubmit, onCancel, submitLabel }: RoleEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<RoleColor>(initial?.color ?? 'neutral');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(initial?.permissions ?? []));
  const [registry, setRegistry] = useState<PermissionDef[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const readOnly = initial?.isOwner === true;

  useEffect(() => {
    fetch('/api/v1/permissions', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRegistry)
      .catch(() => setErr('Не удалось загрузить список permissions'));
  }, []);

  const filtered = useMemo(() => {
    if (!registry) return null;
    const q = search.toLowerCase().trim();
    if (!q) return registry;
    return registry.filter(
      (p) => p.key.toLowerCase().includes(q) || p.label.toLowerCase().includes(q),
    );
  }, [registry, search]);

  const grouped = useMemo(() => {
    if (!filtered) return null;
    const map = new Map<string, PermissionDef[]>();
    for (const p of filtered) {
      const arr = map.get(p.category) ?? [];
      arr.push(p);
      map.set(p.category, arr);
    }
    return map;
  }, [filtered]);

  function toggle(key: string) {
    if (readOnly) return;
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit() {
    if (readOnly) return;
    if (!name.trim()) {
      setErr('Имя обязательно');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({
        name: name.trim(),
        color,
        description: description.trim() || null,
        permissions: [...permissions],
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {readOnly ? (
        <div className="rounded border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200">
          Системная роль <strong>Owner</strong>. Permissions, имя и цвет не редактируются.
        </div>
      ) : null}
      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">{err}</div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-xs uppercase tracking-widest text-neutral-400">Имя</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <div>
          <span className="text-xs uppercase tracking-widest text-neutral-400">Цвет</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={readOnly}
                onClick={() => setColor(c)}
                className={`flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                  color === c
                    ? 'border-sky-400 bg-sky-950/40'
                    : 'border-neutral-800 hover:border-neutral-600'
                } disabled:opacity-50`}
              >
                <RoleColorDot color={c} size="sm" />
                <span className="font-mono">{c}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="block">
        <span className="text-xs uppercase tracking-widest text-neutral-400">Описание</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
          rows={2}
          className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-neutral-400">Permissions</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="поиск..."
            className="w-48 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
          />
        </div>
        {!grouped ? (
          <div className="text-sm text-neutral-500">Загрузка…</div>
        ) : (
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            {CATEGORY_ORDER.filter((c) => grouped.has(c.id)).map((cat) => (
              <div key={cat.id}>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-300">
                  {cat.label}
                </h4>
                <ul className="space-y-1">
                  {grouped.get(cat.id)!.map((p) => {
                    const checked = permissions.has(p.key);
                    return (
                      <li key={p.key}>
                        <label
                          className={`flex items-start gap-2 text-sm ${
                            p.unimplemented ? 'opacity-50' : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5"
                          />
                          <span>
                            {p.label}
                            {p.dangerous ? <span className="ml-1 text-amber-400">⚠️</span> : null}
                            {p.unimplemented ? (
                              <span className="ml-1 text-xs text-neutral-500">(в разработке)</span>
                            ) : null}
                            <span className="ml-2 font-mono text-xs text-neutral-600">{p.key}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {!readOnly ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {submitLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
        >
          Назад
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create /roles list page**

`apps/web/src/app/(dashboard)/roles/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import type { RoleColor } from '@squad/shared-config';

interface RoleRow {
  id: string;
  name: string;
  color: RoleColor;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
  assigned_users_count: number;
}

interface Me {
  permissions: string[];
}

export default function RolesPage() {
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const [rRes, mRes] = await Promise.all([
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rRes.ok) setRows((await rRes.json()) as RoleRow[]);
    if (mRes.ok) setMe((await mRes.json()) as Me);
  }
  useEffect(() => { void load(); }, []);

  async function remove(role: RoleRow) {
    if (
      !confirm(
        `Удалить роль «${role.name}»? Это снимет роль у ${role.assigned_users_count} пользователей.`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/roles/${role.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!rows || !me) return <div className="text-neutral-500">Загрузка…</div>;
  const canCreate = me.permissions.includes('role:create');
  const canEdit = me.permissions.includes('role:edit');
  const canDelete = me.permissions.includes('role:delete');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Роли</h1>
        {canCreate ? (
          <Link
            href="/roles/new"
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Создать роль
          </Link>
        ) : null}
      </div>
      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">{err}</div>
      ) : null}
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
            <tr>
              <th className="p-2 text-left">Роль</th>
              <th className="p-2 text-left">Описание</th>
              <th className="p-2 text-left">Пользователей</th>
              <th className="p-2 text-right">Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-neutral-900">
                <td className="p-2">
                  <div className="flex items-center gap-2">
                    <RoleColorDot color={r.color} />
                    <span className="font-medium">{r.name}</span>
                    {r.is_system_role ? (
                      <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-xs text-amber-300">
                        Системная
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="p-2 text-neutral-400">{r.description ?? '—'}</td>
                <td className="p-2 font-mono">{r.assigned_users_count}</td>
                <td className="p-2 text-right">
                  {canEdit ? (
                    <Link
                      href={`/roles/${r.id}`}
                      className="rounded border border-neutral-800 px-3 py-0.5 text-xs hover:border-neutral-600"
                    >
                      {r.is_system_role && r.name === 'Owner' ? 'Просмотр' : 'Редактировать'}
                    </Link>
                  ) : null}
                  {canDelete && !(r.is_system_role && r.name === 'Owner') ? (
                    <button
                      type="button"
                      onClick={() => remove(r)}
                      disabled={busy}
                      className="ml-2 rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
                    >
                      Удалить
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create /roles/new page**

`apps/web/src/app/(dashboard)/roles/new/page.tsx`:

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { RoleEditor } from '@/components/RoleEditor';

export default function NewRolePage() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Новая роль</h1>
      <RoleEditor
        submitLabel="Создать"
        onCancel={() => router.push('/roles')}
        onSubmit={async (data) => {
          const r = await fetch('/api/v1/roles', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!r.ok) {
            if (r.status === 409) throw new Error('Роль с таким именем уже существует');
            throw new Error(`HTTP ${r.status}`);
          }
          router.push('/roles');
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Create /roles/[id] page**

`apps/web/src/app/(dashboard)/roles/[id]/page.tsx`:

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { RoleEditor } from '@/components/RoleEditor';
import type { RoleColor } from '@squad/shared-config';

interface RoleRow {
  id: string;
  name: string;
  color: RoleColor;
  description: string | null;
  is_system_role: boolean;
  permissions: string[];
}

export default function EditRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [role, setRole] = useState<RoleRow | null>(null);

  useEffect(() => {
    fetch(`/api/v1/roles/${id}`, { credentials: 'include' })
      .then((r) => r.json())
      .then(setRole);
  }, [id]);

  if (!role) return <div className="text-neutral-500">Загрузка…</div>;
  const isOwner = role.is_system_role && role.name === 'Owner';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{role.name}</h1>
      <RoleEditor
        initial={{
          name: role.name,
          color: role.color,
          description: role.description,
          permissions: role.permissions,
          isSystemRole: role.is_system_role,
          isOwner,
        }}
        submitLabel="Сохранить"
        onCancel={() => router.push('/roles')}
        onSubmit={async (data) => {
          const r = await fetch(`/api/v1/roles/${id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!r.ok) {
            if (r.status === 409) throw new Error('Имя занято');
            if (r.status === 400) throw new Error('Owner не редактируется');
            throw new Error(`HTTP ${r.status}`);
          }
          router.push('/roles');
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Build the web app**

```bash
pnpm --filter @squad/web build
```
Expected: PASS.

- [ ] **Step 6: Manual test**

Spin up the stack (`docker compose up -d`), navigate to `/roles`, verify:
- List shows 5 roles with color dots, "Системная" badge on Owner.
- Click "Создать роль" → editor loads with all 47 permissions across 16 categories. Search filter works. ⚠️ on dangerous, "(в разработке)" on unimplemented.
- Create a test role; goes back to list with count `0`.
- Click "Редактировать" on Owner — read-only banner, all checkboxes disabled.
- Click "Редактировать" on non-Owner — toggle a permission and Save.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/RoleEditor.tsx apps/web/src/app/\(dashboard\)/roles/
git commit -m "feat(web/roles): list + editor + create/edit pages"
```

---

## Task 12: Web — /users page

**Files:**
- Create: `apps/web/src/app/(dashboard)/users/page.tsx`

- [ ] **Step 1: Create the page**

`apps/web/src/app/(dashboard)/users/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import type { RoleColor } from '@squad/shared-config';

interface UserRow {
  steam_id64: string;
  canonical_name: string;
  last_seen_at: string;
  role: { id: string; name: string; color: RoleColor; is_system_role: boolean };
}
interface RoleOption { id: string; name: string; color: RoleColor; is_system_role: boolean }
interface Me { permissions: string[] }
interface PlayerHit { steam_id64: string; canonical_name: string }

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [showAssign, setShowAssign] = useState(false);

  async function load() {
    const r = await fetch('/api/v1/users', { credentials: 'include', cache: 'no-store' });
    if (r.ok) setUsers((await r.json()) as UserRow[]);
    const m = await fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' });
    if (m.ok) setMe((await m.json()) as Me);
  }
  useEffect(() => { void load(); }, []);

  if (!users || !me) return <div className="text-neutral-500">Загрузка…</div>;
  const canManage = me.permissions.includes('user:manage_roles');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Пользователи панели</h1>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowAssign(true)}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Назначить роль игроку
          </button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
            <tr>
              <th className="p-2 text-left">Игрок</th>
              <th className="p-2 text-left">SteamID64</th>
              <th className="p-2 text-left">Роль</th>
              <th className="p-2 text-left">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.steam_id64} className="border-t border-neutral-900">
                <td className="p-2">
                  <Link
                    href={`/players/${u.steam_id64}`}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    {u.canonical_name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs">{u.steam_id64}</td>
                <td className="p-2">
                  <span className="inline-flex items-center gap-2">
                    <RoleColorDot color={u.role.color} />
                    {u.role.name}
                  </span>
                </td>
                <td className="p-2 text-neutral-500">
                  {new Date(u.last_seen_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showAssign ? <AssignModal onClose={() => { setShowAssign(false); void load(); }} /> : null}
    </div>
  );
}

function AssignModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerHit[]>([]);
  const [picked, setPicked] = useState<PlayerHit | null>(null);
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/roles', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRoles);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/v1/players?q=${encodeURIComponent(q)}`, {
        credentials: 'include',
      });
      if (r.ok) {
        const body = (await r.json()) as { items: PlayerHit[] };
        setHits(body.items.slice(0, 20));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const ownerRoleId = useMemo(
    () => roles?.find((r) => r.is_system_role && r.name === 'Owner')?.id ?? null,
    [roles],
  );

  async function assign() {
    if (!picked || !roleId) return;
    if (roleId === ownerRoleId) {
      if (!confirm('Это даст пользователю полный доступ к панели. Подтвердить?')) return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/players/${picked.steam_id64}/role`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: roleId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-4 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-lg font-semibold">Назначить роль</h2>
        {err ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">{err}</div>
        ) : null}
        <div>
          <label className="text-xs uppercase text-neutral-400">Игрок</label>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPicked(null); }}
            placeholder="ник или SteamID64"
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
          />
          {hits.length > 0 && !picked ? (
            <ul className="mt-1 max-h-40 overflow-auto rounded border border-neutral-800">
              {hits.map((h) => (
                <li key={h.steam_id64}>
                  <button
                    type="button"
                    onClick={() => { setPicked(h); setHits([]); setQ(h.canonical_name); }}
                    className="block w-full px-2 py-1 text-left text-sm hover:bg-neutral-900"
                  >
                    {h.canonical_name}{' '}
                    <span className="font-mono text-xs text-neutral-500">{h.steam_id64}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <label className="text-xs uppercase text-neutral-400">Роль</label>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm"
          >
            <option value="">— выберите —</option>
            {(roles ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-800 px-3 py-1 text-sm hover:border-neutral-600"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={assign}
            disabled={busy || !picked || !roleId}
            className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Назначить
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm GET /api/v1/players supports `?q=`**

If `apps/api/src/routes/players.ts` doesn't accept `q`, add a query param schema:

```ts
const listQuery = z.object({ q: z.string().min(1).max(64).optional() });
fast.get(
  '/api/v1/players',
  { schema: { querystring: listQuery }, config: { permissions: ['player:view'], audit: false } },
  async (req) => {
    const q = req.query.q?.toLowerCase();
    const rows = await app.db
      .select()
      .from(players)
      .where(q ? sql`canonical_name_normalized LIKE ${`%${q}%`} OR steam_id64::text = ${q}` : undefined)
      .orderBy(desc(players.lastSeenAt))
      .limit(200);
    return { items: rows.map(/* … existing mapping … */), total: rows.length };
  },
);
```

(Adjust to whatever pattern is already in players.ts; this is exemplary.)

- [ ] **Step 3: Build + manual test**

```bash
pnpm --filter @squad/web build
```

Manual:
- Navigate to `/users` as Owner. Table shows everyone with a role.
- Click "Назначить роль игроку". Type partial name → typeahead. Pick a player. Pick role from dropdown. Click "Назначить".
- Re-load — new user shows up.
- Try to assign Owner — confirm dialog appears.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(dashboard\)/users/ apps/api/src/routes/players.ts
git commit -m "feat(web/users): users table + assign-role modal w/ Owner confirm"
```

---

## Task 13: Web — simplify PanelAccessSection + drop /setup pages

**Files:**
- Modify: `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx`
- Delete: `apps/web/src/app/setup/`
- Modify: `apps/web/src/app/login/page.tsx`

- [ ] **Step 1: Rewrite PanelAccessSection in player detail page**

Read the existing `apps/web/src/app/(dashboard)/players/[steam_id64]/page.tsx`. Replace the multi-role list logic with a single-role view:

Replace the `interface RoleAssignment` block, the `PanelAccessSection` function, and its mount with the single-role version. Sample shape:

```tsx
interface SingleRole {
  id: string;
  name: string;
  color: RoleColor;
  is_system_role: boolean;
}

function PanelAccessSection({ steamId64 }: { steamId64: string }) {
  const [current, setCurrent] = useState<SingleRole | null>(null);
  const [editing, setEditing] = useState(false);
  const [allRoles, setAllRoles] = useState<SingleRole[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function reload() {
    const [rRes, listRes] = await Promise.all([
      fetch(`/api/v1/players/${steamId64}/role`, { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (rRes.ok) {
      const body = (await rRes.json()) as { role: SingleRole | null };
      setCurrent(body.role);
    }
    if (listRes.ok) setAllRoles((await listRes.json()) as SingleRole[]);
  }
  useEffect(() => { void reload(); }, []);

  const ownerId = allRoles.find((r) => r.is_system_role && r.name === 'Owner')?.id ?? null;

  async function save(roleId: string | null) {
    if (roleId === ownerId && roleId !== null) {
      if (!confirm('Это даст пользователю полный доступ к панели. Подтвердить?')) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/players/${steamId64}/role`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: roleId }),
      });
      if (r.status === 409) {
        setMsg({ kind: 'err', text: 'Нельзя снять роль у последнего Owner.' });
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await reload();
      setEditing(false);
      setMsg({ kind: 'ok', text: 'Готово.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">Доступ к панели</h2>
      {msg ? (
        <div
          className={`rounded border p-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {msg.text}
        </div>
      ) : null}
      {!editing ? (
        <div className="flex items-center gap-3 text-sm">
          {current ? (
            <span className="inline-flex items-center gap-2">
              <RoleColorDot color={current.color} />
              <span className="font-medium">{current.name}</span>
            </span>
          ) : (
            <span className="text-neutral-500">— нет доступа в панель</span>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-neutral-800 px-3 py-0.5 text-xs hover:border-neutral-600"
          >
            Изменить
          </button>
          {current ? (
            <button
              type="button"
              onClick={() => save(null)}
              disabled={busy}
              className="rounded border border-red-900 px-3 py-0.5 text-xs text-red-400 hover:border-red-700 disabled:opacity-40"
            >
              Снять роль
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-2">
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          >
            <option value="">— выберите —</option>
            {allRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => picked && save(picked)}
            disabled={!picked || busy}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Сохранить
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setPicked(''); }}
            disabled={busy}
            className="rounded border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Отмена
          </button>
        </div>
      )}
    </section>
  );
}
```

Add `import { RoleColorDot } from '@/components/RoleColorDot'; import type { RoleColor } from '@squad/shared-config';` at the top of the file.

The `canManageRoles = me?.permissions.includes('user:manage_roles')` gate stays.

- [ ] **Step 2: Delete /setup web routes**

```bash
rm -rf apps/web/src/app/setup
```

- [ ] **Step 3: Update login page**

In `apps/web/src/app/login/page.tsx`, remove the `setup/check-env` redirect block:

```tsx
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  setError(params.get('error'));
  setSteamId(params.get('steam_id64'));
  (async () => {
    const meRes = await fetch('/api/v1/me', { credentials: 'include' });
    if (meRes.ok) window.location.href = '/dashboard';
  })();
}, []);
```

- [ ] **Step 4: Web build**

```bash
pnpm --filter @squad/web build
```
Expected: PASS.

- [ ] **Step 5: Manual test**

- Open `/players/<steam_id>` page as Owner. PanelAccessSection shows current role with color dot, "Изменить" / "Снять роль" buttons.
- Click "Изменить", pick a different role, save. Verify it persists.
- Try to assign Owner — confirm dialog.
- Verify `/setup` returns 404.
- Verify `/login` no longer redirects to `/setup`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/
git commit -m "refactor(web): single-role PanelAccessSection, drop /setup pages"
```

---

## Task 14: Documentation

**Files:**
- Create: `docs/components/rbac/{README,api,data-model,flows,configuration,testing,troubleshooting,changelog}.md`
- Modify: `docs/architecture/rbac.md`
- Modify: `docs/architecture/decisions.md`
- Modify: `docs/architecture/data-flow.md`
- Modify: `docs/components/db/data-model.md`
- Modify: `docs/components/api/api.md`

- [ ] **Step 1: Create the rbac component dir**

```bash
mkdir -p docs/components/rbac
```

- [ ] **Step 2: Write `docs/components/rbac/README.md`**

Cover: purpose ("permissions for the panel itself"), what it does NOT do (no in-game admins, no per-server scoping), code locations (registry, lib/rbac, routes), dependencies (db, redis), basic example (registering `config.permissions: ['server:view']`).

- [ ] **Step 3: Write `docs/components/rbac/api.md`**

Document the new endpoints: `GET /permissions`, CRUD `/roles`, `GET /users`, `GET/PUT /players/:id/role`. For each: method, path, permission, body schema, response, errors, example.

- [ ] **Step 4: Write `docs/components/rbac/data-model.md`**

Cover: `roles` table (id, name, color, is_system_role, description); `role_permissions` (M:N to permission_key strings); `players.role_id` (NULL semantics); `panel_meta` singleton. Mention the migration `0009_panel_rbac.sql` and what it does.

- [ ] **Step 5: Write `docs/components/rbac/flows.md`**

Three flows: (1) first-login Owner trick (Steam-callback → claimFirstOwner → DB+sentinel), (2) ordinary login (load permissions, redirect on empty set), (3) role mutation → cache invalidation → next request reflects.

- [ ] **Step 6: Write `docs/components/rbac/configuration.md`**

Env vars: none specific to RBAC (it relies on DB). Mention SESSION_TTL_SECONDS (already documented elsewhere).

- [ ] **Step 7: Write `docs/components/rbac/testing.md`**

Document: `permissions.test.ts`, `role-colors.test.ts`, `roles-crud.test.ts`, `player-role-assign.test.ts`, `users-list.test.ts`, `permission-rename-coverage.test.ts`, `setup-removed.test.ts`, `panel-rbac.e2e.test.ts`. How to run each tier.

- [ ] **Step 8: Write `docs/components/rbac/troubleshooting.md`**

Common cases: "user has no access after role assignment" → cache invalidation issue, check `lib/rbac.ts` invalidation chain. "Migration fails with FK violation" → didn't drop FK before parent. "first_owner_claimed wedged" → `UPDATE panel_meta SET first_owner_claimed = false` to reset on dev. "Operator deleted Moderator role and wants it back" → no auto-respawn; manually re-create or reset DB.

- [ ] **Step 9: Write `docs/components/rbac/changelog.md`**

```md
# Changelog

## 2026-04-25

### Added
- Singleton `panel_meta` table (`first_owner_claimed`, `roles_seeded`).
- `players.role_id` column.
- `GET /api/v1/permissions` registry endpoint.
- CRUD `/api/v1/roles`.
- `GET /api/v1/users`.
- `PUT /api/v1/players/:steamId/role`.
- 5 system roles seeded once in migration `0009`.
- 16-color role palette.

### Changed
- Permission keys renamed; see migration 0009 for the mapping.
- `loadUserPermissions` now reads `players.role_id`.
- `claimFirstOwner` reads/writes `panel_meta`.

### Removed
- `player_role_assignments` (M:N).
- `role_server_scopes`.
- `organizations`, `organization_members`.
- `roles.org_id`, `roles.clearance_level`.
- `audit_log.org_id`.
- `/api/v1/setup/*` endpoints + `/setup` web route.
- `hasServerPermission` helper.
- `seedSystemRoles` TS helper (replaced by SQL seed).

### Migration notes
Forward-only destructive — `0009_panel_rbac.sql`. Pre-launch only; no prod data. Truncates `player_api_tokens` because permission renames invalidate stored scopes.
```

- [ ] **Step 10: Update `docs/architecture/rbac.md`**

Replace the current content (it documents the old multi-role + clearance model). New version:
- Permission registry as objects (link to `packages/shared-config/src/permissions.ts`).
- Single role per user.
- 5 system roles, only Owner protected.
- Enforcement remains via `config.permissions` + audit-coverage gate.
- Cache invalidation discussion.

- [ ] **Step 11: Append a new decision record to `docs/architecture/decisions.md`**

Title: `## 2026-04-25 — Panel RBAC: single role per user, registry-objects, drop multi-tenancy`. Sections: Context (where the old model came from, why it didn't fit), Decision (single role + registry), Rationale (5 bullets matching the spec's trade-offs), Consequences (cache invalidation, escalation risk via `user:manage_roles`, `panel_meta` singleton), Alternatives considered (M:N with unique index; clearance levels; per-server scoping; setup wizard).

- [ ] **Step 12: Update `docs/architecture/data-flow.md`**

Find any references to `organizations` / `organization_members`; remove or rewrite. Add a note about `panel_meta` as the source of truth for first-login state.

- [ ] **Step 13: Update `docs/components/db/data-model.md`**

Replace the "user identity" section to reflect: `players` (with `role_id`), `roles`, `role_permissions`, `panel_meta`. Drop `organizations` block.

- [ ] **Step 14: Update `docs/components/api/api.md`**

Add the new endpoints. Remove the old M:N player-roles endpoints. Cross-link to `docs/components/rbac/api.md` instead of duplicating.

- [ ] **Step 15: Verify all relative links**

```bash
grep -rE 'docs/(components|architecture)/' docs/components/rbac/ docs/architecture/rbac.md docs/architecture/decisions.md
```
Open each link and verify the file exists.

- [ ] **Step 16: Commit**

```bash
git add docs/
git commit -m "docs(rbac): component dir + decision record + cross-references"
```

---

## Task 15: Final integration — full test sweep + manual e2e

- [ ] **Step 1: Full type + lint**

```bash
pnpm turbo run typecheck
pnpm biome check .
```
Expected: PASS.

- [ ] **Step 2: Full test suite**

```bash
pnpm turbo run test
```
Expected: PASS, no skips.

- [ ] **Step 3: E2E suite**

```bash
PANEL_TEST_URL=https://squad-panel.lan PANEL_TEST_COOKIE=… PANEL_E2E_SECONDARY_STEAM_ID=… pnpm --filter @squad/api test:e2e
```
Expected: PASS (`install-lifecycle`, `bridge-rpc`, `panel-rbac` all green).

- [ ] **Step 4: Manual validation gate (per user requirement)**

Walk through this scenario by hand on the live stack:

1. Reset DB to fresh `0009` state (drop+re-create + migrate). Confirm `panel_meta.first_owner_claimed=false` and 5 roles.
2. Visit `/`. Click "Login через Steam" with operator's account. Verify redirect to `/` with full Owner access.
3. Verify `panel_meta.first_owner_claimed=true` in DB.
4. Open second Steam account in private browser, log in. Verify `/no-access` page (this is a player who doesn't have a role yet).
5. As Owner, navigate to `/users`. Verify the table shows the operator. Click "Назначить роль игроку", typeahead the second account, pick "Viewer". Save.
6. Second account refresh: visits `/dashboard`. Verifies sidebar shows only "Дашборд", "Серверы", "Игроки", "Журнал действий", "Аккаунт", "API-токены" (the `*:view` items Viewer has).
7. As Owner, `/roles` → "Создать роль" → name "Manager", color "blue", check `server:view`, `server:start`, `server:stop`. Save.
8. As Owner, `/users` → second account → assign "Manager".
9. Second account: refresh dashboard, click on a server, see Start/Stop buttons.
10. As Owner, `/roles/<manager>` → uncheck `server:start` → save.
11. Second account clicks Start → 403 (cache-invalidation worked, no 30s wait).
12. As Owner, `/roles` → delete "Manager" (confirm dialog mentions "1 пользователь"). Confirm.
13. Second account refresh → `/no-access` (role gone).
14. As Owner, try to remove own Owner role via `/players/<owner>` → 409, error message displayed.
15. Restore second account: assign Viewer.

If any step fails — fix immediately, do not move on.

- [ ] **Step 5: Open PR**

```bash
git push -u origin feat/panel-rbac
gh pr create --title "feat: panel RBAC (Эпик 2)" --body "$(cat <<'EOF'
## Summary
- Single role per user via `players.role_id`.
- Permission registry objects (`{key, category, label, dangerous?, unimplemented?}`).
- 16-color role palette.
- 5 system roles seeded in SQL; only Owner protected.
- CRUD `/roles`, `/users`, `PUT /players/:id/role`.
- First-login Owner trick on Steam-callback (replaces `/setup` wizard).
- Drops `organizations`, `organization_members`, `role_server_scopes`, M:N table.

## Test plan
- [x] `pnpm turbo run typecheck`
- [x] `pnpm turbo run test`
- [x] `pnpm --filter @squad/api test:e2e` (install-lifecycle + bridge-rpc + panel-rbac)
- [x] Manual: full RBAC lifecycle on live stack (15-step checklist in plan)
EOF
)"
```

---

## Self-Review

Spec coverage check:
- §1 (single role) → Tasks 1, 2, 4 ✓
- §2 (no clearance) → Task 4 ✓
- §3 (no per-server) → Task 1 (drop table), 4 (drop hasServerPermission) ✓
- §4 (no orgs) → Task 1 ✓
- §5 (registry objects) → Task 3 ✓
- §6 (full registry incl. unimplemented) → Task 3 ✓
- §7 (5 system roles, Owner only protected) → Task 1 (seed), 7 (CRUD guard) ✓
- §8 (/users + PanelAccessSection) → Tasks 7, 12, 13 ✓
- §9 (first-login trick + drop /setup) → Tasks 5, 8, 13 ✓
- §10 (audit before/after) → Task 7 (CRUD audits via `config.audit`); the audit plugin already does before/after snapshots — verify in implementation, no new code needed beyond `config.audit` declarations ✓
- §11 (cache invalidation) → Task 4, used in Task 7 ✓
- §12 (TRUNCATE tokens) → Task 1 ✓
- §13 (16 colors as marker) → Tasks 3, 10, 11, 12, 13 ✓
- §UI (search, ⚠️, "в разработке", confirm-dialog) → Tasks 11, 12, 13 ✓
- §Migration (10 commits) → Tasks 0-15 ✓
- §Testing (Tier 1/2/3 + manual gate) → Tasks 3, 7, 9, 15 ✓
- §Out-of-scope → respected (no triggers/scheduler/whitelist UI) ✓

Type consistency:
- `PermissionDef`, `PERMISSIONS`, `PERMISSION_KEYS` defined in Task 3, used consistently in Tasks 4, 7, 11.
- `RoleColor`, `ROLE_COLORS` defined Task 3, used Tasks 10, 11, 12, 13.
- `claimFirstOwner` signature unchanged (Task 5); call site untouched (Task 8).
- `invalidatePermissionCacheForRole` defined Task 4, used Task 7.
- `players.role_id` added Task 1, used everywhere starting Task 4.
- `panel_meta` schema Task 2, used Task 5.

No placeholders detected.

---
