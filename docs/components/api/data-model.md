# API — Data Model

All request/response shapes defined here are validated with Zod. The canonical Zod schemas live in `packages/shared-types/src/api.ts`; route-specific schemas are defined inline in `apps/api/src/routes/`.

---

## Request DTOs

### `serverCreateInput`

Used by `POST /api/v1/servers`. Source: `packages/shared-types/src/api.ts`.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `display_name` | string | yes | 1–120 characters |
| `slug` | string | yes | `^[a-z0-9][a-z0-9-]{0,63}$` |
| `description` | string \| null | no | max 500 characters |
| `game_port` | integer | yes | 1024–65535 |
| `query_port` | integer | yes | 1024–65535 |
| `beacon_port` | integer | yes | 1024–65535 |
| `rcon_port` | integer | yes | 1024–65535 |
| `multihome` | string | no | default `"0.0.0.0"` |
| `max_players` | integer | no | 1–100, default 100 |
| `tickrate` | integer | no | 10–120, default 50 |
| `extra_args` | string | no | default `""` |
| `launch_args_override` | string \| null | no | — |
| `cpu_affinity` | string \| null | no | — |
| `cpu_weight` | integer \| null | no | 1–10000 |
| `niceness` | integer \| null | no | -20 to 19 |
| `memory_high_mb` | integer \| null | no | positive |
| `memory_max_mb` | integer \| null | no | positive |
| `io_weight` | integer \| null | no | 1–10000 |

### `createRole` body

Used by `POST /api/v1/roles`. Source: `apps/api/src/routes/roles.ts`.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–64 characters, unique |
| `color` | RoleColor | yes | one of 16 valid color names |
| `description` | string | no | max 256 characters |
| `permissions` | string[] | yes | subset of `PERMISSIONS` keys, max length = `PERMISSIONS.length` |

### `updateRole` body

Used by `PUT /api/v1/roles/:id`. All fields optional.

| Field | Type | Constraints |
|---|---|---|
| `name` | string | 1–64 characters |
| `color` | RoleColor | valid color |
| `description` | string \| null | max 256 characters |
| `permissions` | string[] | valid permission keys |

### `createApiToken` body

Used by `POST /api/v1/me/tokens`. Source: `apps/api/src/routes/me-tokens.ts`.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–100 characters (trimmed) |
| `scopes` | string[] | yes | subset of the caller's own permissions; deduped server-side |

---

## Response shapes

### `Me`

Returned by `GET /api/v1/me`. Source: `apps/api/src/routes/auth.ts`.

```json
{
  "steam_id64": "76561198012345678",
  "canonical_name": "PlayerName",
  "avatar_url": "https://avatars.steamstatic.com/...",
  "permissions": ["server:view", "config:view", "player:view"]
}
```

`permissions` is the de-duplicated array of permission keys granted by the player's current role, evaluated fresh on every request.

### Server list item

Returned in `items[]` by `GET /api/v1/servers`. Base shape from `serverRow` schema plus RCON and player state joined by the status reconciler.

```json
{
  "id": "0190abcd-...",
  "display_name": "My Squad Server",
  "slug": "my-squad",
  "description": null,
  "status": "running",
  "tags": [],
  "game_port": 7787,
  "query_port": 27165,
  "beacon_port": 15000,
  "rcon_port": 21114,
  "max_players": 100,
  "tickrate": 50,
  "multihome": "0.0.0.0",
  "created_at": "2026-04-01T12:00:00.000Z",
  "updated_at": "2026-04-25T08:30:00.000Z",
  "rcon_state": "connected",
  "player_count": 42,
  "last_poll_at": "2026-04-25T08:30:00.000Z"
}
```

`status` values: `pending`, `installing`, `ready`, `starting`, `running`, `stopping`, `stopped`, `failed`.

`rcon_state` values: `connected`, `authenticating`, `reconnecting`, `disconnected`, `failed`, `not_polled`. The value `not_polled` is returned (not `null`) when the server is not in the `running|starting` state.

### Server detail

Returned by `GET /api/v1/servers/:id`. Shape defined in `apps/web/src/app/(dashboard)/servers/[id]/page.tsx` (client-side mirror).

```json
{
  "server": { /* serverRow fields */ },
  "settings": {
    "server_id": "...",
    "game_port": 7787,
    "query_port": 27165,
    "beacon_port": 15000,
    "rcon_port": 21114,
    "max_players": 100,
    "tickrate": 50,
    "multihome": "0.0.0.0",
    "install_path": "/var/lib/squad-panel/configs/..."
  },
  "rcon_status": {
    "state": "connected",
    "ts": "2026-04-25T08:30:00.000Z",
    "player_count": 42,
    "last_poll_at": "2026-04-25T08:30:00.000Z",
    "tickrate_rt": 50,
    "current_map": "Fallujah_AAS_v1"
  },
  "container": {
    "state": "running",
    "running": true,
    "started_at": "2026-04-25T06:00:00.000Z",
    "finished_at": null,
    "image": "squad-server:latest",
    "pid": 12345,
    "restart_count": 0,
    "exit_code": 0,
    "cpu_percent": 12.5,
    "mem_used_bytes": 2147483648,
    "mem_limit_bytes": 8589934592
  },
  "host": {
    "address": "192.168.1.100",
    "hostname": "panel-host"
  }
}
```

### Role item

Returned in the array by `GET /api/v1/roles` and as a single object by `GET /api/v1/roles/:id`.

```json
{
  "id": "0190abcd-...",
  "name": "Moderator",
  "color": "sky",
  "description": "Can kick and ban players.",
  "is_system_role": false,
  "permissions": ["player:view", "player:kick", "player:ban"],
  "assigned_users_count": 5
}
```

`is_system_role: true` with `name: "Owner"` identifies the protected system role that cannot be edited or deleted.

### User item

Returned in the array by `GET /api/v1/users`.

```json
{
  "steam_id64": "76561198012345678",
  "canonical_name": "PlayerName",
  "last_seen_at": "2026-04-25T08:00:00.000Z",
  "role": {
    "id": "0190abcd-...",
    "name": "Moderator",
    "color": "sky",
    "is_system_role": false
  },
  "assigned_at": null,
  "assigned_by": null
}
```

### Player item

Returned in `items[]` by `GET /api/v1/players`. Source: `playerRow` schema in `packages/shared-types/src/api.ts`.

```json
{
  "steam_id64": "76561198012345678",
  "canonical_name": "PlayerName",
  "eos_id": "0002abcdef...",
  "first_seen_at": "2026-01-01T00:00:00.000Z",
  "last_seen_at": "2026-04-25T08:00:00.000Z",
  "total_time_played_seconds": 36000
}
```

### Audit entry

Returned in `items[]` by `GET /api/v1/audit`. Source: `auditEntry` schema in `packages/shared-types/src/api.ts`.

```json
{
  "id": "1234567890",
  "created_at": "2026-04-25T08:00:00.000Z",
  "actor_user_id": "0190abcd-...",
  "actor_display_name": "admin@example.com",
  "actor_ip": "192.168.1.50",
  "actor_kind": "user",
  "action_type": "config.write",
  "target_type": "server_config",
  "target_id": "0190abcd-...",
  "status_code": 200,
  "duration_ms": 45
}
```

`actor_kind` values: `user`, `system`, `external`.

`id` is a `bigserial`; it must be serialized as a string to avoid BigInt truncation.

### API token item

Returned in the array by `GET /api/v1/me/tokens`.

```json
{
  "id": "0190abcd-...",
  "name": "CI runner",
  "scopes": ["server:view", "config:view"],
  "last_used_at": "2026-04-20T10:00:00.000Z",
  "created_at": "2026-04-01T09:00:00.000Z",
  "revoked_at": null
}
```

Creation response additionally includes `plaintext: string` — the full token value shown only once.

### Paginated wrapper

Many list endpoints return a paginated envelope (source: `paginated()` factory in `packages/shared-types/src/api.ts`):

```json
{
  "items": [...],
  "total": 150,
  "page": 1,
  "page_size": 50
}
```

---

## WebSocket frame shapes

### Install progress (`/api/v1/servers/:id/install/ws`)

Each frame is a JSON object. Frames arrive as the install progresses.

**Progress line frame:**
```json
{
  "ts": "2026-04-25T08:01:00.000Z",
  "step": "depot_check",
  "stream": "stdout",
  "message": "Verifying depot..."
}
```

**Completion frame:**
```json
{ "done": true, "final": "done" }
```

**Error frame:**
```json
{ "done": true, "final": "error", "error": "container_run failed: ..." }
```

### Container log tail (`/api/v1/servers/:id/logs/ws`)

Each frame:
```json
{
  "ts": "2026-04-25T08:01:00.000Z",
  "stream": "stdout",
  "message": "LogSquad: [2026.04.25-08.01.00:000][001]..."
}
```

The WS closes when the container exits or the client disconnects.

---

## Audit `context` payload conventions

The `context` column in `audit_log` is a JSON object. Its contents depend on `action_type`.

| `action_type` | Context fields |
|---|---|
| `config.write` | `{before_sha256, after_sha256, file_name, server_id}` — content itself is never stored |
| `server.create` | `{server_id, slug, display_name}` |
| `server.delete` | `{server_id, slug}` |
| `server.start` / `server.stop` / `server.restart` | `{server_id, container_id}` |
| `role.create` / `role.update` / `role.delete` | `{role_id, name}` |
| `user.api_token.create` | `{token_id, name, scopes}` |
| `user.api_token.revoke` | `{token_id}` |
| `user.logout` | `{session_id}` |
| `player.role.assign` | `{steam_id64, role_id, role_name}` |
| `player.role.revoke` | `{steam_id64, former_role_id}` |

All mutating routes must declare `config.audit: {action, resource}` in the Fastify route config. The `apps/api/test/audit-coverage.test.ts` suite scans all registered routes at startup and fails if any POST/PUT/PATCH/DELETE lacks an audit declaration.
