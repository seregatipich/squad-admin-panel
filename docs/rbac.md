# RBAC

The panel uses a permission-key model, not an enum of roles. A role is just a bag of permission-key strings plus a clearance level (0–1000).

## Why strings, not an enum?

Adding a new permission never touches code, migrations, or clients; it is a single `INSERT INTO role_permissions`. Routes and UI use literal strings (e.g. `'server:start'`) that the type-system treats as `PermissionKey`. Registered permission keys live in `packages/shared-config/src/permissions.ts`; adding one there is a one-line change everyone else picks up via the shared package.

## Permission keys (Phase 0)

```
server:view
server:create
server:edit
server:delete
server:start
server:stop
server:restart
server:install
server:update
player:view
player:view_ips          ← permission-gated on the player detail page
player:view_eos_id
player:view_steam_id
audit:view
user:view
user:create
user:edit
user:delete
role:manage
permission:manage
host:view
host:metrics
host:bridge_control
org:view
org:edit
```

## System roles (seeded per-org on setup)

| Role          | Clearance | Permissions                                                                                                |
|---------------|-----------|------------------------------------------------------------------------------------------------------------|
| Owner         | 1000      | every registered permission                                                                                |
| Senior Admin  | 750       | servers full, players + IPs + EOS + Steam, audit:view, host:view + metrics, user:view, org:view            |
| Admin         | 500       | server:view/start/stop/restart, player:view + eos_id + steam_id, host:view + metrics, org:view             |
| Viewer        | 100       | `*:view` only                                                                                              |

Non-system roles can be created per-org by users with `role:manage`, but Phase 0 ships no UI for that — admins manage them via SQL or a follow-up Phase 1 endpoint.

## Enforcement

Every HTTP route that requires auth lists its permissions in `config.permissions`:

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

The shared `preHandler` hook (see `apps/api/src/plugins/auth.ts`) rejects anonymous calls with 401 and missing permissions with 403. A CI guard (`no-audit-bypass` test) asserts every mutation route has a `config.audit` entry so nothing sneaks in without an audit trail.

## Clearance

A numeric clearance level (`roles.clearance_level`, 0–1000) lets us compare "can this user manage that user?" without permission explosion. Rule of thumb: an actor can manage a target only when `actor.clearance > target.clearance`. Phase 0 doesn't expose user management in the UI, so clearance is only seeded and not yet enforced; Phase 1 adds invite + role-assignment endpoints that use it.
