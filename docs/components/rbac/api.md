# `rbac` — public API

All RBAC routes require an active session cookie (or Bearer token with the appropriate scope). Anonymous requests receive `401`. Missing permission receives `403`.

## `GET /api/v1/permissions`

Return the full permission registry as defined in `@squad/shared-config`.

**Permission required:** `role:view`

**Response 200**

```json
[
  {
    "key": "server:start",
    "category": "servers",
    "label": "Start сервера"
  },
  {
    "key": "server:delete",
    "category": "servers",
    "label": "Удалить сервер с очисткой",
    "dangerous": true
  },
  {
    "key": "mod:kick",
    "category": "moderation",
    "label": "Kick через UI",
    "dangerous": true,
    "unimplemented": true
  }
]
```

Fields `dangerous` and `unimplemented` are present only when `true`; they are never `false`.

---

## Roles

### `GET /api/v1/roles`

List all roles, sorted `is_system_role DESC, name ASC`.

**Permission required:** `role:view`

**Response 200**

```json
[
  {
    "id": "0193b6c3-1f70-7a91-9bee-1234567890ab",
    "name": "Owner",
    "color": "red",
    "is_system_role": true,
    "description": null,
    "permissions": ["server:view", "server:start", "...all keys..."],
    "assigned_users_count": 1
  }
]
```

---

### `GET /api/v1/roles/:id`

Single role detail.

**Permission required:** `role:view`

**Errors**

| Status | Body | When |
|---|---|---|
| 404 | `{error: "role_not_found"}` | UUID does not exist. |

---

### `POST /api/v1/roles`

Create a new role.

**Permission required:** `role:create`

**Request body**

| Field | Type | Constraint |
|---|---|---|
| `name` | string | 1..100 chars, unique across all roles. |
| `color` | string | One of the 16 allowed color slugs (see `ROLE_COLORS`). |
| `description` | string? | Optional. |
| `permissions` | string[] | Each must be a `PermissionKey`. |

**Response 201** — full role object (same shape as `GET /api/v1/roles/:id`).

**Errors**

| Status | Body | When |
|---|---|---|
| 400 | Zod validation error | Missing required field, unknown color, invalid permission key. |
| 409 | `{error: "role_name_taken"}` | A role with that name already exists. |

**Audit:** `role.create` / `role`.

---

### `PUT /api/v1/roles/:id`

Update role name, color, description, or permissions. All fields are optional; omitting a field leaves it unchanged.

**Permission required:** `role:edit`

**Request body** — same fields as POST, all optional.

**Response 200** — updated role object.

**Errors**

| Status | Body | When |
|---|---|---|
| 400 | `{error: "owner_role_immutable"}` | Target role has `is_system_role = true AND name = 'Owner'`. |
| 404 | `{error: "role_not_found"}` | |
| 409 | `{error: "role_name_taken"}` | Rename conflicts with an existing role. |

Side-effect: calls `invalidatePermissionCacheForRole(roleId)` which immediately clears the Redis cache for every player carrying this role. The in-process TTL safety-net (30 s) is a fallback only.

**Audit:** `role.update` / `role`.

---

### `DELETE /api/v1/roles/:id`

Delete a role. Cascades `players.role_id` to `NULL` for every player carrying it (they lose panel access immediately after cache expiry).

**Permission required:** `role:delete`

**Response 200** — `{ ok: true }`

**Errors**

| Status | Body | When |
|---|---|---|
| 400 | `{error: "owner_role_immutable"}` | Attempt to delete the Owner role. |
| 404 | `{error: "role_not_found"}` | |

Side-effect: calls `invalidatePermissionCacheForRole(roleId)` before the DELETE so in-flight requests see the change as soon as their current handler returns.

**Audit:** `role.delete` / `role`.

---

## Users

### `GET /api/v1/users`

List all players who have a non-NULL `role_id`, joined to their role. Sorted by `last_seen_at DESC`.

**Permission required:** `user:view`

**Response 200**

```json
[
  {
    "steam_id64": "76561198000000123",
    "canonical_name": "PlayerName",
    "last_seen_at": "2026-04-25T10:00:00.000Z",
    "role": {
      "id": "0193b6c3-1f70-7a91-9bee-1234567890ab",
      "name": "Admin",
      "color": "sky",
      "is_system_role": false
    },
    "assigned_at": null,
    "assigned_by": null
  }
]
```

`assigned_at` and `assigned_by` are `null` in this iteration — future schema extension.

---

## Player role management

### `GET /api/v1/players/:steamId/role`

Return the player's current role, or `{role: null}` if none.

**Permission required:** `user:view`

**Response 200**

```json
{ "role": { "id": "...", "name": "Admin", "color": "sky", "is_system_role": false } }
```

or

```json
{ "role": null }
```

---

### `PUT /api/v1/players/:steamId/role`

Assign or clear the player's role.

**Permission required:** `user:manage_roles`

**Request body**

| Field | Type | Constraint |
|---|---|---|
| `role_id` | uuid \| null | `null` removes the role (player loses panel access). |

**Response 200** — `{ ok: true }`

**Errors**

| Status | Body | When |
|---|---|---|
| 404 | `{error: "role_not_found"}` | `role_id` UUID does not exist in `roles`. |
| 409 | `{error: "cannot_remove_last_owner"}` | The change would leave zero players with the Owner role. |

Side-effect: calls `invalidatePermissionCache(steamId64)` immediately after the UPDATE so the player's next request sees the new permission set without waiting for the TTL.

**Audit:** `player.role.assign` / `player`.

---

## Removed endpoints

These no longer exist and return 404:

- `GET /api/v1/players/:steamId/roles` (old M:N list)
- `POST /api/v1/players/:steamId/roles` (old M:N add)
- `DELETE /api/v1/players/:steamId/roles/:roleId` (old M:N remove)
- `GET /api/v1/setup/check-env`
- `POST /api/v1/setup/init`
