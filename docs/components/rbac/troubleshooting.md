# `rbac` — troubleshooting

## Symptom: permission cache stale after role assignment

After `PUT /players/:id/role` or `PUT /roles/:id`, a user's effective permissions should update on the very next request. If they do not, the point-invalidation may have silently failed.

**Diagnostics**

```bash
# Check current DB state for the player
psql "$DATABASE_URL" -c "
  SELECT p.steam_id64, r.name AS role, array_agg(rp.permission_key) AS perms
  FROM players p
  JOIN roles r ON r.id = p.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  WHERE p.steam_id64 = 76561198000000123
  GROUP BY p.steam_id64, r.name;
"

# Check Redis cache key
redis-cli GET "rbac:perms:76561198000000123"
# If this key is present and stale, delete it manually:
redis-cli DEL "rbac:perms:76561198000000123"
```

The cache key is a simple Redis `SET`/`GET` with a 30 s TTL, so worst case you wait 30 s for it to expire naturally. In production the point-invalidation always runs; a stale cache after that window means the DELETE failed silently — check api logs.

---

## Symptom: Owner lockout — panel has no active Owner

If `first_owner_claimed = true` but the only Owner player has been reassigned to a non-Owner role (or had their `role_id` set to NULL), no one can reach routes that require Owner-level permissions.

**Recovery**

```bash
psql "$DATABASE_URL" -c "
  UPDATE players
  SET role_id = (SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true)
  WHERE steam_id64 = <steam_id64_of_trusted_player>;
"
```

Then clear the Redis cache for that player:

```bash
redis-cli DEL "rbac:perms:<steam_id64>"
```

The `cannot_remove_last_owner` API guard prevents this from happening via the UI, but a direct DB edit bypasses the guard. Consider it an emergency recovery procedure only.

---

## Symptom: "Owner role missing" — 0009 migration not applied

If the Owner role was never seeded, the first-login Owner trick will find no role to assign and `claimFirstOwner` will set `first_owner_claimed = true` on `panel_meta` while leaving `players.role_id = NULL`. Subsequent logins will skip the trick entirely and everyone will be redirected to `/no-access`.

**Diagnostics**

```bash
psql "$DATABASE_URL" -c "SELECT * FROM panel_meta;"
psql "$DATABASE_URL" -c "SELECT name, is_system_role FROM roles;"
psql "$DATABASE_URL" -c "SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true;"
```

**Fix**

Ensure migrations 0009–0012 are applied:

```bash
DATABASE_URL=postgres://admin:$PASS@127.0.0.1:5432/admin pnpm db:migrate
```

If `first_owner_claimed` is already `true` but no Owner role exists, the Owner role needs to be INSERTed manually (copy the relevant INSERT from `0009_panel_rbac.sql`) and then a player needs to be directly assigned as described above.

---

## Symptom: deleted preset role (e.g. Moderator) is not recreated automatically

The seeded roles (Senior Admin, Admin, Moderator, Viewer) are preset for convenience but have `is_system_role = false`. An operator can delete them via `DELETE /api/v1/roles/:id`. The migration does not re-seed on restart and the API has no auto-respawn logic.

If a preset role is deleted and needs to be restored, re-create it manually via `POST /api/v1/roles` with the appropriate permissions, or via a direct INSERT from the migration file.

---

## Symptom: 400 `owner_role_immutable` when trying to edit the Owner role

The Owner role has `is_system_role = true` and `name = 'Owner'`. These two flags together block all PUT and DELETE calls via the API. This is by design. The only way to change the Owner's permissions is a direct DB write:

```sql
DELETE FROM role_permissions WHERE role_id = (
  SELECT id FROM roles WHERE name = 'Owner' AND is_system_role = true
);
-- re-insert desired permissions
INSERT INTO role_permissions (id, role_id, permission_key) VALUES (...);
```

After a direct DB write, clear the permission cache for all Owner players:

```bash
psql "$DATABASE_URL" -c "
  SELECT p.steam_id64 FROM players p
  JOIN roles r ON r.id = p.role_id
  WHERE r.name = 'Owner';
" | while read sid; do redis-cli DEL "rbac:perms:$sid"; done
```

---

## Useful queries

```sql
-- All players with their role
SELECT p.steam_id64, p.canonical_name, r.name AS role, r.color
FROM players p
LEFT JOIN roles r ON r.id = p.role_id
ORDER BY r.name NULLS LAST, p.canonical_name;

-- Players with no role (no panel access)
SELECT steam_id64, canonical_name FROM players WHERE role_id IS NULL;

-- Permission set for a specific role
SELECT permission_key FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin')
ORDER BY permission_key;
```
