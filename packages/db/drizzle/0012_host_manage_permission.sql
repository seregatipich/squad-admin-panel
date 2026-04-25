BEGIN;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'host:manage'
FROM roles r
WHERE r.name IN ('Owner', 'Senior Admin')
ON CONFLICT (role_id, permission_key) DO NOTHING;

COMMIT;
