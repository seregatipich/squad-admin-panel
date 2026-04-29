-- =====================================================================
-- 0015 — Re-seed roles for Эпик 2 Phase 2.
--
-- Adds the spec roles (Admin, Moderator, QueuePriority, Cameraman, Intern)
-- alongside the existing Owner. Updates Owner to use a hex color and the
-- three access flags. Each non-Owner spec role is created with only Squad
-- in-game permissions and the appropriate access-flag triple — no
-- entries are written to role_permissions, since panel-side permissions
-- are derived from the flags at runtime by apps/api/src/lib/rbac.ts.
--
-- Pre-existing legacy roles (Senior Admin / Admin / Moderator / Viewer
-- from 0009) are *replaced* in-place when their name matches one of the
-- spec names. Senior Admin and Viewer are deleted entirely — they are
-- not in the spec set. Tests that previously depended on the legacy
-- Viewer fixture should call ensureViewerFixture() from
-- apps/api/test/helpers/viewer-fixture.ts at beforeAll() time. Other
-- custom roles are untouched.
--
-- Forward-only. Pre-launch.
-- =====================================================================

BEGIN;

-- 1. Owner: switch to hex color, set all three access flags TRUE. Owner
--    behaviour is also hardcoded in the API; the row values are
--    informational here so SQL inspection matches the spec.
UPDATE roles
SET color = '#FF0000',
    panel_access = true,
    can_assign_roles = true,
    can_edit_roles = true
WHERE name = 'Owner' AND is_system_role = true;

-- 2. Drop legacy panel grants for the legacy "Senior Admin" / "Admin" /
--    "Moderator" rows so the upcoming reseed of those names has no
--    stale rows pointing at them. (CASCADE on role_permissions is
--    role_id-keyed; rows survive a role rename, so we wipe the values
--    explicitly. role_squad_permissions does not yet exist before this
--    migration ran for those legacy rows.)
DELETE FROM role_permissions
WHERE role_id IN (
  SELECT id FROM roles WHERE name IN ('Senior Admin','Admin','Moderator')
);

-- 3. Spec roles: upsert by name (case-sensitive, matches existing UNIQUE
--    INDEX roles_name_key). Each row's color, description and flags get
--    rewritten to the spec values.
INSERT INTO roles (id, name, description, color, is_system_role,
                   panel_access, can_assign_roles, can_edit_roles)
VALUES
  (gen_random_uuid(), 'Admin',         'Server lifecycle + moderation, без управления ролями.', '#CD5C5C', false, true,  false, false),
  (gen_random_uuid(), 'Moderator',     'Модерация и просмотр игроков.',                          '#2E8B57', false, true,  false, false),
  (gen_random_uuid(), 'QueuePriority', 'VIP с reserved slot.',                                   '#DAA520', false, false, false, false),
  (gen_random_uuid(), 'Cameraman',     'Spectator/cameraman + клиентские demo.',                 '#8B008B', false, false, false, false),
  (gen_random_uuid(), 'Intern',        'Стажёр модерации без kick/ban.',                         '#005EC2', false, false, false, false)
ON CONFLICT (name) DO UPDATE SET
  description      = EXCLUDED.description,
  color            = EXCLUDED.color,
  panel_access     = EXCLUDED.panel_access,
  can_assign_roles = EXCLUDED.can_assign_roles,
  can_edit_roles   = EXCLUDED.can_edit_roles;

-- 4. Drop legacy non-spec rows. The spec lists exactly six default roles
--    (Owner + Admin + Moderator + QueuePriority + Cameraman + Intern);
--    "Senior Admin" and "Viewer" predate this spec and are not part of
--    it. Existing players bound to either role get role_id=NULL via FK.
DELETE FROM roles WHERE name IN ('Senior Admin', 'Viewer') AND is_system_role = false;

-- 5. Squad permissions per spec role. Wipe any prior rows for these
--    role ids first so re-running the migration is idempotent.
DELETE FROM role_squad_permissions
WHERE role_id IN (
  SELECT id FROM roles
  WHERE name IN ('Owner','Admin','Moderator','QueuePriority','Cameraman','Intern')
);

INSERT INTO role_squad_permissions (role_id, squad_permission_key)
SELECT r.id, k
FROM roles r
CROSS JOIN LATERAL unnest(CASE r.name
  WHEN 'Owner' THEN ARRAY[
    'startvote','changemap','pause','cheat','private','balance','chat','kick',
    'ban','config','cameraman','immune','manageserver','featuretest','reserve',
    'demos','clientdemos','debug','teamchange','forceteamchange','canseeadminchat'
  ]
  WHEN 'Admin' THEN ARRAY[
    'changemap','pause','cheat','balance','chat','kick','ban','config','cameraman',
    'manageserver','featuretest','reserve','debug','teamchange','canseeadminchat'
  ]
  WHEN 'Moderator' THEN ARRAY[
    'balance','chat','cameraman','reserve','teamchange','canseeadminchat'
  ]
  WHEN 'QueuePriority' THEN ARRAY['reserve']
  WHEN 'Cameraman' THEN ARRAY[
    'balance','cameraman','reserve','clientdemos','teamchange'
  ]
  WHEN 'Intern' THEN ARRAY[
    'balance','chat','cameraman','reserve','teamchange','canseeadminchat'
  ]
END) AS k
WHERE r.name IN ('Owner','Admin','Moderator','QueuePriority','Cameraman','Intern');

-- 6. Spec roles do NOT carry rows in role_permissions; panel-side
--    permissions are derived from the flag triple by RBAC at runtime.

UPDATE panel_meta SET roles_seeded = true WHERE id = 1;

COMMIT;
