# RBAC

The panel uses a permission-key model. A role is a bag of permission-key strings plus a clearance level (0–1000). Adding a new permission is a one-line append in [`packages/shared-config/src/permissions.ts`](../../packages/shared-config/src/permissions.ts) — no migration, no client changes.

## Permission keys

The full registered set lives in the shared package. Current keys:

```
server:view              server:edit              server:start
server:create            server:delete            server:stop
server:install           server:update            server:restart
server:config:write      server:config:history

player:view              player:view_ips          player:view_eos_id
player:view_steam_id

audit:view

user:view                user:create              user:edit              user:delete
role:manage              permission:manage

host:view                host:metrics             host:bridge_control

org:view                 org:edit
```

Routes refer to these as literal strings; the type system narrows them to `PermissionKey`.

## System roles (seeded per-org)

| Role | Clearance | Permissions |
|---|---:|---|
| Owner | 1000 | every registered permission |
| Senior Admin | 750 | servers full + config write/history, players (incl. IPs/EOS/Steam), audit:view, host:view+metrics, user:view, org:view |
| Admin | 500 | server:view/start/stop/restart + config:history, player:view + EOS + Steam, host:view + metrics, org:view |
| Viewer | 100 | `*:view` only (`server:view`, `server:config:history`, `player:view`, `audit:view`, `host:view`, `org:view`) |

The exact mapping is `SYSTEM_ROLE_PERMISSIONS` in [`packages/shared-config/src/permissions.ts`](../../packages/shared-config/src/permissions.ts).

Non-system roles can be created per-org by users with `role:manage`. Phase 0 ships no UI for that — operators manage them via SQL.

## Enforcement

Every authed route lists its permissions in `config.permissions`:

```ts
app.route({
  method: 'POST',
  url: '/api/v1/servers/:id/start',
  config: {
    permissions: ['server:start'],
    audit: { action: 'server.start', resource: 'server' },
  },
  handler: async (req, reply) => { /* ... */ },
});
```

The shared `preHandler` hook (`apps/api/src/plugins/auth.ts`) returns 401 for anonymous calls and 403 for missing permissions.

## Audit-coverage CI gate

`apps/api/test/audit-coverage.test.ts` walks every registered route at startup and fails the suite if any `POST`/`PUT`/`PATCH`/`DELETE` lacks a `config.audit` entry. New mutating routes therefore cannot ship without an audit trail.

## Clearance

`roles.clearance_level` (0–1000) decides "can this user manage that user?" — an actor can manage a target only when `actor.clearance > target.clearance`. Phase 0 doesn't expose user management in the UI yet; clearance is seeded but not enforced. Phase 1 adds invite + role-assignment endpoints that consume it.
