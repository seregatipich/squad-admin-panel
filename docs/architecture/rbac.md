# RBAC

The panel uses a permission-key model. A role is a bag of permission-key strings. Adding a new permission is a one-line append in [`packages/shared-config/src/permissions.ts`](../../packages/shared-config/src/permissions.ts) — no migration, no client changes.

## Permission registry

Each entry in `PERMISSIONS` is a `PermissionDef` with:
- `key` — unique string identifier (e.g. `server:start`)
- `category` — one of the 16 values in `PERMISSION_CATEGORIES`
- `label` — human-readable Russian description
- `dangerous?: true` — present when the action is destructive or irreversible
- `unimplemented?: true` — present when the action is planned but not yet active

Current keys by category:

| Category | Keys |
|---|---|
| servers | `server:view`, `server:install`, `server:start`, `server:stop`, `server:force_stop`, `server:restart`, `server:delete`, `server:edit_settings`, `server:update`, `server:download_logs` |
| configs | `config:view`, `config:edit`, `config:rollback` |
| players | `player:view`, `player:view_ips`, `player:view_notes`*, `player:edit_notes`*, `player:set_flags`* |
| moderation | `mod:kick`, `mod:warn`, `mod:ban_temp`, `mod:ban_perm`, `mod:unban` |
| admin_groups | `admin_group:view`, `admin_group:edit` |
| whitelist | `whitelist:view`, `whitelist:edit` |
| host | `host:view`, `host:metrics` |
| audit | `audit:view`, `audit:export`* |
| events | `events:view` |
| users | `user:view`, `user:manage_roles` |
| roles | `role:view`, `role:create`, `role:edit`, `role:delete` |
| backup | `backup:view`*, `backup:trigger`*, `backup:restore`* |
| api_tokens | `api_token:create`, `api_token:revoke` |
| discord | `discord:link`* |
| triggers | `trigger:view`*, `trigger:edit`* |
| scheduler | `scheduler:view`*, `scheduler:edit`* |

_* = `unimplemented: true` — key is registered but no route enforces it yet.
`admin_group:view` и `admin_group:edit` являются production-active: ими защищены
`/api/v1/admins-cfg/drift`, `/api/v1/admins-cfg/drift/all` и
`/api/v1/admins-cfg/sync`.
`whitelist:view` и `whitelist:edit` тоже production-active — ими защищены роуты
`/api/v1/whitelist/*`. Whitelist-роль — это обычная **глобальная** роль
(`panel_meta.whitelist_role_id`), которая реплицируется в `Admins.cfg` каждого
сервера через `publishAdminsCfgSyncForAllServers` (см. решение WL-2 в
[`decisions.md`](./decisions.md))._

Routes refer to these as literal strings; the type system narrows them to `PermissionKey`.

## Role colors

Roles have a `color` column constrained by `CONSTRAINT roles_color_palette CHECK (color IN (...))`. The 16 allowed values are mirrored in [`packages/shared-config/src/role-colors.ts`](../../packages/shared-config/src/role-colors.ts) as `ROLE_COLORS`. The test suite in `packages/shared-config/test/role-colors.test.ts` asserts that the TS constant and the SQL constraint stay in sync.

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
