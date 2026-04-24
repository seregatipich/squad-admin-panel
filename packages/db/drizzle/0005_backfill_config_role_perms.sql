-- Backfill missing server:config:* permissions onto the four system
-- roles (Owner, Senior Admin, Admin, Viewer) for every organization.
--
-- The `config_versions` feature (migration 0003) introduced two new
-- permission keys — `server:config:write` and `server:config:history` —
-- but seeded system roles on organizations that already existed didn't
-- pick them up. That left Owners with 403 on PUT /configs/:name and on
-- the Редактор/История/Blame tabs.
--
-- This migration inserts the expected entries and is idempotent
-- (ON CONFLICT DO NOTHING on the role_permissions PK). Fresh installs
-- are unaffected because the seed helper already emits these rows.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key
FROM roles r
CROSS JOIN (
  VALUES
    ('server:config:write'),
    ('server:config:history')
) AS k(key)
WHERE r.name = 'Owner' AND r.is_system_role = true
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key
FROM roles r
CROSS JOIN (
  VALUES
    ('server:config:write'),
    ('server:config:history')
) AS k(key)
WHERE r.name = 'Senior Admin' AND r.is_system_role = true
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'server:config:history'
FROM roles r
WHERE r.name = 'Admin' AND r.is_system_role = true
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'server:config:history'
FROM roles r
WHERE r.name = 'Viewer' AND r.is_system_role = true
ON CONFLICT DO NOTHING;
