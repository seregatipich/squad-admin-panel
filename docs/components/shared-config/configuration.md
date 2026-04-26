# `shared-config` — configuration

`@squad/shared-config` contains only compile-time constants and pure functions. It reads no environment variables directly. All sensitive defaults are resolved by callers.

## Package export paths

| Export path | Browser-safe | Contents |
|---|:---:|---|
| `@squad/shared-config` | No (`node:stream`) | Full barrel — use in API, workers, server components |
| `@squad/shared-config/permissions` | Yes | `PERMISSIONS`, `PERMISSION_KEYS`, `PERMISSION_CATEGORIES`, `PermissionDef`, `PermissionKey`, `isPermissionKey` |
| `@squad/shared-config/role-colors` | Yes | `ROLE_COLORS`, `RoleColor`, `ROLE_COLOR_SET`, `isRoleColor` |

Use the sub-paths in Next.js client components to avoid a bundler error on `node:stream`.

## Constants that must stay in sync with external systems

| Constant | External dependency | Risk if out of sync |
|---|---|---|
| `BRIDGE_METHODS` | Go handler switch in `apps/bridge/internal/handlers/handlers.go` | Unknown methods silently fail with `invalid_args` or `forbidden` |
| `BRIDGE_MAX_FRAME_BYTES` | Go constant in `apps/bridge/internal/framing/framing.go` | One side drops large frames the other accepted |
| `ROLE_COLORS` | `roles_color_palette` SQL CHECK in `packages/db/drizzle/0009_panel_rbac.sql` | DB insert for new role fails at constraint |
| `ALLOWED_CONFIG_FILES` | Bridge path allowlist in `apps/bridge/internal/handlers/handlers.go` | File write accepted by TS but rejected by Go, or vice versa |
| `SERVER_IMAGE`, `DEPOT_INIT_IMAGE` | Bridge image allowlist in the same Go handler | `container_run` fails with `forbidden` |

## Environment variables consumed by callers

These are not read by the package itself; they affect how callers use the exported values.

| Variable | Consumed by | Description |
|---|---|---|
| `RCON_HOST_DEFAULT` | `resolveRconHost()` callers (API, worker-rcon) | Default RCON host when `rcon_host` is NULL in DB credentials |
| `BRIDGE_SOCKET_PATH` | `apps/api` Fastify plugin | Override for the default socket path constant |

See [`docs/operations/environment-variables.md`](../../operations/environment-variables.md) for the full environment variable table.

## Build

The package compiles with `tsc -p tsconfig.json` to `dist/`. The `development` export condition in `package.json` points at `src/*.ts` directly so other workspace packages can import without building during local development (via `tsx`/`ts-node`/vitest).
