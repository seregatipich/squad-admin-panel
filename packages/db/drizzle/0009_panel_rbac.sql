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

-- 8. Delete existing tokens — pre-launch, scope renames invalidate
--    any locally-minted tokens. (TRUNCATE blocked by audit_log FK.)
DELETE FROM player_api_tokens;

-- 9. Wipe role_permissions — seeder rebuilds from scratch.
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
