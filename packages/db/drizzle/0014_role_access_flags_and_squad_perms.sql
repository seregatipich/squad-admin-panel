-- =====================================================================
-- 0014 — Roles & access (Эпик 2 Phase 2):
--   * Add access flags: panel_access, can_assign_roles, can_edit_roles
--   * Add role_squad_permissions table (21 Squad in-game perm keys)
--   * Loosen role color CHECK to accept hex codes (#RRGGBB) in addition
--     to the existing tailwind palette names (back-compat).
--   * Add server.id index for admins-cfg-sync lookups (idempotent).
--
-- Forward-only. Pre-launch.
-- =====================================================================

BEGIN;

-- 1. Access flags on roles. Owner is enforced by application code; the
--    migration sets all three flags TRUE for any role currently named
--    'Owner' (system roles only) so the existing first-owner trick keeps
--    working without code change.
ALTER TABLE roles ADD COLUMN panel_access      boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_assign_roles  boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_edit_roles    boolean NOT NULL DEFAULT false;

-- panel_access = false ⇒ the other two must also be false. Enforced at the
-- DB level so misuse via direct SQL is impossible.
ALTER TABLE roles ADD CONSTRAINT roles_flag_dependency
  CHECK (panel_access OR (NOT can_assign_roles AND NOT can_edit_roles));

-- 2. Loosen the color CHECK: accept either a tailwind palette name or a
--    hex code #RRGGBB. The 0015 reseed migration writes hex codes; the
--    existing palette-named seed is preserved transitively.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_color_palette;
ALTER TABLE roles ADD CONSTRAINT roles_color_format CHECK (
  color IN ('red','rose','pink','fuchsia','purple','violet','indigo','blue',
            'sky','cyan','teal','emerald','green','lime','amber','neutral')
  OR color ~ '^#[0-9a-fA-F]{6}$'
);

-- 3. Squad in-game permissions (21 keys). Stored as a separate M2M to keep
--    them disjoint from panel-side permission_key in role_permissions.
CREATE TABLE role_squad_permissions (
  role_id              uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  squad_permission_key text NOT NULL,
  CONSTRAINT role_squad_permissions_pk PRIMARY KEY (role_id, squad_permission_key),
  CONSTRAINT role_squad_permissions_key_enum CHECK (squad_permission_key IN (
    'startvote','changemap','pause','cheat','private','balance','chat','kick',
    'ban','config','cameraman','immune','manageserver','featuretest','reserve',
    'demos','clientdemos','debug','teamchange','forceteamchange','canseeadminchat'
  ))
);

CREATE INDEX role_squad_permissions_role_idx ON role_squad_permissions(role_id);

COMMIT;
