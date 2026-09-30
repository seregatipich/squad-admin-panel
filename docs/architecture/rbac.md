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
| players | `player:view`, `player:view_ips`, `player:manage_alt_detection`, `player:view_notes`*, `player:edit_notes`*, `player:set_flags` |
| moderation | `mod:kick`, `mod:warn`, `mod:ban_temp`, `mod:ban_perm`, `mod:unban`, `ban_source:view`, `banlist:read` |
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
| triggers | `trigger:view`, `trigger:edit`* |
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

The shared `onRequest` hook (`apps/api/src/plugins/auth.ts`) returns 401 for anonymous calls and 403 for missing permissions.

### Fail-closed default (#246)

The hook is **fail-closed**: a route requires an authenticated session (`req.user`) unless it explicitly opts out with `config.public: true`. `config.permissions` narrows further, requiring specific permission keys on top of a session. There is no third, implicit state — a route that sets neither field is authenticated-required by default, not public.

```ts
// apps/api/src/plugins/auth.ts
if (req.routeOptions?.config?.public === true) return;
if (!req.user) {
  reply.code(401).send({ error: 'unauthenticated' });
  return;
}
const required = req.routeOptions?.config?.permissions ?? [];
// ...403 loop against `required`
```

Before #246 the check was inverted: a route with no `config.permissions` returned early and was silently public. Because most routes in this codebase authorise through an in-handler `Guard()` helper rather than `config.permissions`, that gap was usually masked — but two routes shipped to production unauthenticated purely because nobody had added `config.permissions`: `GET /api/docs*` (the full OpenAPI schema and Swagger UI) and `GET /api/v1/host/bridge-status`. `config.public: true` makes "this route is intentionally public" an explicit, reviewed decision instead of an accident of omission. It is reserved for a short, deliberate allowlist: health/readiness probes (`/health`, `/ready`), signature- or token-gated webhooks (`integrations-balancer.ts`, `integrations-vip.ts`, `discord-interactions.ts`, `public-media.ts`'s upload-token redemption), the public data portals (`public-stats.ts`, `public-clans.ts`, `public-appeals.ts`), the pre-login BSS SSO round-trip (`auth-bss.ts`), and the setup wizard's status probe (`setup.ts`'s `GET /status`, not `POST /complete`). The API's Prometheus registry, `GET /metrics`, is not on this list: it requires `host:metrics` and Caddy does not route it (#9).

### Player IP visibility (#10)

Raw player IPs, and the per-IP coordinates derived from them, are gated by `player:view_ips` (granted only to roles with `can_view_ips`), never by `panel_access` alone. Routes that return other data alongside IPs read the effective permission set (`req.user.permissions.permissions`), so an API token sees IPs only when its scopes include `player:view_ips`:

- `GET /api/v1/players/:playerId` — `ips: []` and `ips_visible: false` without it.
- `GET /api/v1/events/:eventId` and `GET /api/v1/events/export` — the top-level `ip` of every event payload (e.g. `player.connected`) is returned as `null` without it. All `/api/v1/events*` routes additionally require `events:view` through `config.permissions`, so a token must carry that scope to read the journal.
- `GET /api/v1/players/:playerId/geo-anomalies` and `GET /api/v1/geo-anomalies` — `points` (IP + latitude/longitude) is empty without it; the country-level summary stays.

### Panel reads narrowed to a catalogue scope (audit #89/#101/#114)

A route guard that checks only `panel_access` lets an API token through as soon as it carries any one scope (`narrowToTokenScopes` keeps `panelAccess` for every non-empty scope set). The reads below therefore also declare a catalogue key in `config.permissions`, and keep their `panel_access` guard so a session role without `panel_access` stays out even when it holds an explicit `role_permissions` row:

| Route | Scope |
|---|---|
| `GET /api/v1/chat/messages`, `GET /api/v1/chat/messages/count` | `events:view` |
| `GET /api/v1/automation-rules`, `GET /api/v1/automation-runs` | `trigger:view` |
| `GET /api/v1/ban-sources`, `GET /api/v1/ban-sources/:id` | `ban_source:view` |
| `GET /api/v1/analytics/dashboard` | `server:view` |

Session users with `panel_access` are unaffected: `derivePanelPermissions` grants them every catalogue key.

### Alt-detection settings (#43)

`GET /api/v1/settings/alt-detection` needs `player:view_ips` and reports `can_edit`. `PUT /api/v1/settings/alt-detection` and `POST`/`DELETE …/ignored-ips` need `player:manage_alt_detection`, which a role gets only with both `can_view_ips` and `can_edit_roles` (Owner always): weights, thresholds and ignored ranges can switch shared-IP matching off panel-wide, so IP-history read access alone must not change them. Ignore entries broader than `/8` (IPv4) or `/32` (IPv6) are rejected with 400.

### Config secrets (#10)

`config:view` and `server:view` never grant a config secret. The `Password=` value of `Rcon.cfg` and the `LicenseKey=` value of `License.cfg` exist in plaintext only in the file on disk (and encrypted in `server_credentials`); every config response (`GET /configs/:name`, `versions/:vid`, `diff`, `blame`, `drift/diff`, `GET /servers/archive/:id/configs/:filename`) and every `config_versions` row the panel writes (editor writes, install seed, reset-default, deletion backup) carries `********` instead. Reads also mask rows written before the fix, since `config_versions` is append-only. See `apps/api/src/lib/config-secrets.ts`.

`Password=` and `Port=` in `Rcon.cfg` are panel-managed (#42): a write through the config editor (PUT, restore, drift accept/revert, reset-default) whose resulting file disagrees with `server_credentials` is refused with `422 rcon_credentials_managed`, because the panel's RCON clients connect with the credentials row. A masked `Password=********` line is always filled with the `server_credentials` password (the file on disk only when no credentials row exists). Other lines stay editable.

### Per-file config write permissions (#42)

`config:edit` (and `config:rollback` for restore/revert) is not enough to write a config file whose content grants what another permission guards. The write routes (`PUT /configs/:name`, `restore/:vid`, `drift/accept`, `drift/revert`, `reset-default`) also require:

| File | Extra permission | Why |
| --- | --- | --- |
| `Bans.cfg`, `RemoteBanListHosts.cfg` | `mod:ban_perm` (derived only for roles with the squad `ban` permission) | a line bans a player |
| `Admins.cfg`, `RemoteAdminListHosts.cfg` | `user:manage_roles` (derived only for roles with `can_assign_roles`) | a line grants Squad admin rights |

A caller without it gets `403 { error: 'forbidden', required_permission }` and the file is not touched.

## Audit-coverage CI gate

`apps/api/test/audit-coverage.test.ts` builds the route table with `registerRoutes()` — the same list `server.ts` serves — and fails the suite if any `POST`/`PUT`/`PATCH`/`DELETE` lacks a declarative `config.audit: { action, resource }`. The hook in `plugins/audit.ts` then writes an entry for every outcome, denied (`403`) and rejected (`404`/`409`/`422`) attempts included; a handler passes before/after snapshots through `req.auditSnapshots`. `'manual'` marks a handler that calls `writeAuditEntry` itself (the test checks its module does). `audit: false` is accepted only for machine-integration endpoints and for a frozen legacy list of routes that still write their own entries on the success path; that list may only shrink. Until audit #102/#116 the guard registered a hand-picked set of route modules, so `ban-sources.ts` and `banned-names.ts` shipped with `audit: false` unnoticed.
