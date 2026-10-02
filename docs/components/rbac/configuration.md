# `rbac` — configuration

RBAC does not introduce any new environment variables. It relies on the database connection already configured for `apps/api`; the permission cache lives in the API process and needs no Redis.

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | api | Postgres connection string for `roles`, `role_permissions`, `players`, `panel_meta`. | yes |

## Compile-time constants

Defined in [`apps/api/src/lib/rbac.ts`](../../../apps/api/src/lib/rbac.ts):

| Constant | Value | Purpose |
|---|---|---|
| `TTL_MS` | `30000` | Lifetime of a cached permission context. Safety-net; point-invalidation is the primary mechanism. |
| `PERMISSION_CACHE_MAX_ENTRIES` | `5000` | Upper bound on cached contexts; past it the oldest entry is evicted. |

## Permission registry

The registry is code, not configuration. Adding or renaming a permission requires editing `packages/shared-config/src/permissions.ts` and updating the relevant `config.permissions: [...]` entries in route files. The `audit-coverage.test.ts` and `permission-rename-coverage.test.ts` test files act as CI guards.

## Role color palette

The 16 named colors are defined in [`packages/shared-config/src/role-colors.ts`](../../../packages/shared-config/src/role-colors.ts). The SQL CHECK constraint `roles_color_format` allows those names or a `#RRGGBB` hex code. Unit tests assert the names stay in sync with migration `0009`; if they diverge, `pnpm turbo run test` fails.
