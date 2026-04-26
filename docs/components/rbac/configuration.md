# `rbac` — configuration

RBAC does not introduce any new environment variables. It relies entirely on the database connection and Redis instance already configured for `apps/api`.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | api | Postgres connection string for `roles`, `role_permissions`, `players`, `panel_meta`. | yes |
| `REDIS_URL` | yes | — | api | Used for permission-cache keys `rbac:perms:{steam_id64}` (TTL 30 s). | no |

## Compile-time constants

Defined in [`apps/api/src/lib/rbac.ts`](../../../apps/api/src/lib/rbac.ts):

| Constant | Value | Purpose |
|---|---|---|
| `PERMISSION_CACHE_TTL_SECONDS` | `30` | Redis TTL for `rbac:perms:{steam_id64}`. Safety-net; point-invalidation is the primary mechanism. |

## Permission registry

The registry is code, not configuration. Adding or renaming a permission requires editing `packages/shared-config/src/permissions.ts` and updating the relevant `config.permissions: [...]` entries in route files. The `audit-coverage.test.ts` and `permission-rename-coverage.test.ts` test files act as CI guards.

## Role color palette

The 16 allowed colors are defined in [`packages/shared-config/src/role-colors.ts`](../../../packages/shared-config/src/role-colors.ts). The SQL CHECK constraint in `roles.color` mirrors the same list. A unit test asserts they stay in sync — if they diverge, `pnpm turbo run test` fails.
