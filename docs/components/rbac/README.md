# `rbac` — role-based access control for the panel

Controls which Steam users can log into the panel and what they can do once inside. A player gets access by having a non-NULL `role_id`; the role carries a bag of permission keys that gate every API route and UI element.

## Responsibilities

- Define the permission registry (keys, categories, labels, danger/unimplemented flags).
- Provide five seeded system roles at DB migration time (Owner, Senior Admin, Admin, Moderator, Viewer).
- Enforce single-role assignment per player (`players.role_id uuid NULL`).
- Load and cache a player's effective permissions on every authed request (TTL 30 s, point-invalidated on role changes).
- Guard the Owner role against deletion and protect against last-Owner removal.
- Run the first-login Owner trick so the first Steam login on a fresh panel automatically becomes Owner.
- Expose CRUD endpoints for role management and a `/users` list of players who have a role.

## Non-responsibilities

- In-game Squad admin groups (Admins.cfg) — that is Эпик 3; only the `admin_group:view` and `admin_group:edit` permission stubs live here.
- Per-server permission scoping — `role_server_scopes` was dropped. All permissions are global.
- Multi-tenancy / organisations — `organizations` and `organization_members` were dropped.
- Setup wizard — replaced by the first-login Owner trick.
- Role hierarchy, clearance levels, or role composition.
- Expiring role assignments.
- UI for managing the permission registry — the registry is code, not data.

## Code locations

| Concern | File |
|---|---|
| Permission registry | [`packages/shared-config/src/permissions.ts`](../../../packages/shared-config/src/permissions.ts) |
| Role-color palette | [`packages/shared-config/src/role-colors.ts`](../../../packages/shared-config/src/role-colors.ts) |
| Permission loading + cache | [`apps/api/src/lib/rbac.ts`](../../../apps/api/src/lib/rbac.ts) |
| First-login Owner trick | [`apps/api/src/lib/first-owner.ts`](../../../apps/api/src/lib/first-owner.ts) |
| `GET /api/v1/permissions` | [`apps/api/src/routes/permissions.ts`](../../../apps/api/src/routes/permissions.ts) |
| Roles CRUD | [`apps/api/src/routes/roles.ts`](../../../apps/api/src/routes/roles.ts) |
| Users list | [`apps/api/src/routes/users.ts`](../../../apps/api/src/routes/users.ts) |
| Player role assign/read | [`apps/api/src/routes/players.ts`](../../../apps/api/src/routes/players.ts) |
| DB schema — roles | [`packages/db/src/schema/roles.ts`](../../../packages/db/src/schema/roles.ts) |
| DB schema — players | [`packages/db/src/schema/players.ts`](../../../packages/db/src/schema/players.ts) |
| DB schema — panel_meta | [`packages/db/src/schema/panel-meta.ts`](../../../packages/db/src/schema/panel-meta.ts) |
| Web — roles list + editor | [`apps/web/src/app/(dashboard)/roles/`](../../../apps/web/src/app/(dashboard)/roles/) |
| Web — users table | [`apps/web/src/app/(dashboard)/users/page.tsx`](../../../apps/web/src/app/(dashboard)/users/page.tsx) |
| Web — shared role editor | [`apps/web/src/components/RoleEditor.tsx`](../../../apps/web/src/components/RoleEditor.tsx) |
| Web — role color dot | [`apps/web/src/components/RoleColorDot.tsx`](../../../apps/web/src/components/RoleColorDot.tsx) |

## Dependencies

- `@squad/db` — `roles`, `role_permissions`, `players`, `panel_meta` tables.
- `@squad/shared-config` — `PERMISSIONS`, `PERMISSION_KEYS`, `PermissionKey`, `ROLE_COLORS`.
- `apps/api/src/plugins/auth.ts` — calls `loadUserPermissions` on every authed request.
- Redis — permission cache keys `rbac:perms:{steam_id64}` (TTL 30 s).

## Components depending on this

- Every RBAC-gated API route — relies on `req.user.permissions` populated by `loadUserPermissions`.
- `apps/api/src/lib/api-tokens.ts` — intersects token scopes with the player's current role permissions; see [`docs/components/api-tokens/`](../api-tokens/README.md).
- Web nav — sidebar items filtered by `user.permissions`.

## Basic example

```ts
// Check if caller may start a server (from a route preHandler)
app.route({
  method: 'POST',
  url: '/api/v1/servers/:id/start',
  config: { permissions: ['server:start'], audit: { action: 'server.start', resource: 'server' } },
  handler: async (req, reply) => { /* ... */ },
});
// auth.ts preHandler calls loadUserPermissions and returns 403 if 'server:start' is absent.
```

## Related docs

- [`docs/architecture/rbac.md`](../../architecture/rbac.md) — architecture-level overview of the permission model.
- [`docs/architecture/decisions.md`](../../architecture/decisions.md) — decision record for single-role, registry-objects, and multi-tenancy removal.
- [`docs/components/api/api.md`](../api/api.md) — RBAC reference section with all route signatures.
- [`docs/components/api-tokens/README.md`](../api-tokens/README.md) — Bearer token scope intersection.
