# `rbac` — flows

## First-login Owner trick

Выполняется внутри `GET /api/v1/auth/bss/callback` после серверного обмена
одноразового кода и проверки SteamID64, в одной транзакции PostgreSQL под
advisory lock.

```
BSS callback handler
      │
      ├── UPSERT players (steam_id64, canonical_name, ...)
      │
      └── claimFirstOwner(db, steam_id64)
             │
             │  BEGIN
             │  SELECT pg_advisory_xact_lock(hashtextextended('panel_meta_first_owner', 0))
             │
             ├── SELECT first_owner_claimed FROM panel_meta WHERE id = 1
             │
             ├── already true ──► skip (normal login flow)
             │
             └── false
                    │
                    ├── owner role exists?
                    │   (SELECT 1 FROM players p JOIN roles r ON r.id = p.role_id
                    │    WHERE r.name = 'Owner' AND r.is_system_role = true)
                    │
                    ├── yes ──► skip (race was lost; normal login flow)
                    │
                    └── no
                           │
                           ├── UPDATE players
                           │     SET role_id = (SELECT id FROM roles
                           │                    WHERE name = 'Owner'
                           │                    AND is_system_role = true)
                           │     WHERE steam_id64 = $1
                           │
                           └── UPDATE panel_meta SET first_owner_claimed = true
                                  │
                                  COMMIT
```

The advisory lock prevents a race where two simultaneous first-logins both see `first_owner_claimed = false` and both try to claim the role. Only one transaction wins the lock; the other sees `first_owner_claimed = true` when it reads and skips.

After the trick runs once, `first_owner_claimed` stays `true` forever. Subsequent logins proceed directly to the panel access check: role with `panel_access` → `panel`-scoped session cookie → redirect `/`; no `panel_access` (or no role) → `self_service`-scoped session cookie → redirect `/me`.

### Sentinel file is informational only

After a successful claim, the bridge writes `/var/lib/squad-panel/.first-owner-claimed` (JSON: `{steam_id64, claimed_at}`). The file is **not consulted on subsequent claim attempts** — the DB is the single source of truth. The sentinel exists for ops/forensic introspection only (`readSentinelHint` helper).

This was a deliberate change after a wedge: previously the sentinel short-circuited the claim path. After `docker compose down -v` + reinstall, the DB reset to `first_owner_claimed = false` but the sentinel file persisted on the host, blocking every subsequent first-login attempt and leaving the panel without an Owner. Trusting the DB and treating the sentinel as a hint avoids that class of failure entirely. See `docs/components/rbac/troubleshooting.md` "Wedge after reinstall" for the full incident.

---

## Ordinary login flow

```
Steam callback ──validates OpenID──► UPSERT players
                                             │
                                             ▼
                                      claimFirstOwner  (no-op after first run)
                                             │
                                             ▼
                                      loadUserPermissions → panelAccess
                                             │
                              ┌──────────────┴──────────────┐
                              │                             │
                           no panel_access            panel_access
                              │                             │
                              ▼                             ▼
                    set __Host-sid cookie         set __Host-sid cookie
                    scope self_service            scope panel
                    redirect /me                  redirect /
```

Both branches issue a session — VIPSUB-5 (#171) needs a player without `panel_access` authenticated so they can manage their own VIP subscription on `/me`. The `self_service` scope is what keeps the panel closed to them: `apps/api/src/plugins/auth.ts` downgrades such a request to anonymous on every route that does not declare `config.selfService`, so a panel-gated route answers exactly the same 401 it did when no cookie was set at all. The downgrade stops applying as soon as the player actually holds `panel_access` — no re-login needed.

Once inside the panel, `auth.ts` calls `loadUserPermissions(steam_id64)` on every request:

```
loadUserPermissions(steam_id64)
      │
      ├── Redis GET rbac:perms:{steam_id64}
      │     │
      │     └── cache hit ──► return cached set
      │
      └── cache miss
             │
             ├── SELECT role_id FROM players WHERE steam_id64 = $1
             ├── role_id IS NULL ──► return empty set, SET cache EX 30
             └── SELECT permission_key FROM role_permissions WHERE role_id = $1
                    │
                    └── SET rbac:perms:{steam_id64} <serialized keys> EX 30
                        return permission set
```

---

## Role mutation → cache invalidation

### Single player (after `PUT /players/:id/role`)

```
PUT /api/v1/players/:steamId/role  { role_id }
      │
      ├── UPDATE players SET role_id = $role_id WHERE steam_id64 = $steamId
      │
      └── invalidatePermissionCache(steamId64)
             │
             └── Redis DEL rbac:perms:{steamId64}
```

The player's next request will miss the cache and reload from DB with the new role.

### All carriers of a role (after `PUT /roles/:id` or `DELETE /roles/:id`)

```
PUT /api/v1/roles/:id  { permissions: [...] }
      │
      ├── UPDATE role_permissions (delete old, insert new)
      │
      └── invalidatePermissionCacheForRole(db, roleId)
             │
             ├── SELECT steam_id64 FROM players WHERE role_id = $roleId
             │
             └── Redis DEL rbac:perms:{steam_id64}  (for each carrier)
```

For DELETE the same invalidation runs before the role row is removed, so no carrier retains a stale cache that still resolves to the now-deleted role.

---

## Role CRUD guard — Owner immutability

```
PUT /api/v1/roles/:id   or   DELETE /api/v1/roles/:id
      │
      ├── SELECT is_system_role, name FROM roles WHERE id = $id
      │
      └── is_system_role = true AND name = 'Owner'
             │
             ├── yes ──► 400 { error: "owner_role_immutable" }
             └── no  ──► proceed
```

---

## Owner-lockout guard (last Owner protection)

```
PUT /api/v1/players/:steamId/role  { role_id: <non-owner-uuid> | null }
      │
      ├── is current role Owner?
      │     SELECT r.name FROM players p JOIN roles r ON r.id = p.role_id
      │     WHERE p.steam_id64 = $steamId
      │
      └── yes — check if this is the last Owner
             │
             ├── SELECT count(*) FROM players p JOIN roles r ON r.id = p.role_id
             │     WHERE r.name = 'Owner'
             │
             ├── count = 1 ──► 409 { error: "cannot_remove_last_owner" }
             └── count > 1 ──► proceed with UPDATE
```
