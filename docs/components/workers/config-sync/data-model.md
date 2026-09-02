# worker-config-sync — Data model

The worker reads three tables and writes to one.

## Read

### `roles`

Used to enumerate every role the panel manages. Shape (subset relevant to this worker):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | unique; also written verbatim into `Admins.cfg` as `Group=<name>:…` and `Admin=<sid>:<name>` |
| `is_system_role` | boolean | Owner-only |
| `panel_access`, `can_assign_roles`, `can_edit_roles` | boolean | not consulted by the worker (those gate panel access; squad-side ignores them) |

### `role_squad_permissions`

Source of truth for what permissions each role gets in `Admins.cfg`.

| Column | Type | Notes |
|---|---|---|
| `role_id` | uuid → roles | ON DELETE CASCADE |
| `squad_permission_key` | text | one of the 21 spec keys; CHECK-constrained |

### `players`

```sql
SELECT p.steam_id64::text, r.name AS role_name
FROM players p JOIN roles r ON r.id = p.role_id
WHERE p.role_id IS NOT NULL
ORDER BY r.name, p.steam_id64;
```

The worker maps each row to an `Admin=<steam_id64>:<role_name>` line provided the role has at least one Squad permission.

### `servers`

`SELECT id FROM servers WHERE deleted_at IS NULL` — drives the active set of streams and drift targets.

## Write

### `audit_log`

Each successful sync emits a row with `action_type ∈ { 'admins_cfg.synced', 'admins_cfg.force_synced' }`. The chained `row_hash` is honoured (`prev_hash || canonical_json(payload)` → sha256). The row `context` carries the post-write RCON reload outcome as `reload` (`'enqueued' | 'skipped_rcon_disconnected' | 'failed'`). See [api.md](./api.md#audit_log-rows-postgres) for the exact payload.

### Redis status key (not Postgres)

`admins-cfg:status:<server_id>` — see [api.md](./api.md#admins-cfgstatusserver_id).

### Redis RCON command stream (not Postgres)

`rcon:commands:<server_id>` — для нового outbox команда
`AdminReloadServerConfig` с `request_id=admins-cfg-sync:<outbox_id>`; живой
сервер считается применённым только после точного `ok=true` результата. Старые
сообщения без `_outbox_id` используют совместимый best-effort режим.

## In-memory model — managed segment

The worker constructs and writes a deterministic byte block:

```
//SQUAD-PANEL BEGIN — не редактировать вручную
Group=<roleA>:perm1,perm2,...
Group=<roleB>:perm1,...
                                    (blank line if both groups + admins are present)
Admin=<steam_id64>:<roleA>
Admin=<steam_id64>:<roleA>
Admin=<steam_id64>:<roleB>
//SQUAD-PANEL END
```

Invariants:

- Roles with `len(squad_permissions) = 0` are **omitted** (no `Group=` line, no associated `Admin=` lines either — those players are panel-only with no in-game effect).
- `Group=` lines are sorted alphabetically by role name; permissions within a group are sorted alphabetically too. Determinism is required for the sha256 idempotency check to be stable.
- `Admin=` lines are sorted by `(role_name, steam_id64)` (numeric tie-break by steam_id64).
- Line endings are `\r\n` (Windows-style) — Squad expects this even on Linux.
- The worker preserves bytes outside the markers verbatim. Other tools can co-exist by using their own marker fences (e.g. `//SQSTAT DELIMETER`).

The hash used by the idempotency / drift check is `sha256(segment_body_with_CRLF)`.

## Migration history

- `2026-04-27` — table `role_squad_permissions` added, seeded for the spec roles. Worker rewritten to consume it.
- Prior to that the worker was a P2 stub with no DB usage.
