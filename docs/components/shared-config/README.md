# `shared-config` — invariants pinned at build time

Constants that have to match across multiple components. Importable as `@squad/shared-config`.

## Contents

- [`bridge-methods.ts`](../../../packages/shared-config/src/bridge-methods.ts) — `BRIDGE_METHODS`, `BRIDGE_STREAMING_METHODS`, image/container-name allowlists, `ALLOWED_CONFIG_FILES`, `HOT_RELOAD_FILES`, `ROTATION_FILES`, `configFileClass()`.
- [`permissions.ts`](../../../packages/shared-config/src/permissions.ts) — `PERMISSIONS` registry array (each entry: `key`, `category`, `label`, optional `dangerous: true`, optional `unimplemented: true`), `PERMISSION_KEYS`, `PERMISSION_CATEGORIES`, `PermissionDef`, `PermissionKey`, `isPermissionKey()`.
- [`role-colors.ts`](../../../packages/shared-config/src/role-colors.ts) — `ROLE_COLORS` (16-entry palette matching the `roles_color_palette` SQL CHECK constraint), `RoleColor`, `ROLE_COLOR_SET`, `isRoleColor()`.
- [`heartbeat.ts`](../../../packages/shared-config/src/heartbeat.ts) — helper for workers that publish `worker:heartbeat:{name}`.
- [`log-stream.ts`](../../../packages/shared-config/src/log-stream.ts) + [`log-stream-sink.ts`](../../../packages/shared-config/src/log-stream-sink.ts) — connector-logs encoding (`encodeLogEntry`/`decodeLogEntry`, source/level codes, `PANEL_LOGS_STREAM = 'panel:logs'`, `PANEL_LOGS_MAXLEN`) and the pino multistream sink that producers attach to.
- [`metrics-pack.ts`](../../../packages/shared-config/src/metrics-pack.ts) — `HOST_METRICS_STREAM = 'host:metrics'`, `packHostMetrics`/`unpackHostMetrics`, the wire shape used by `worker-metrics-sampler` and the `/host/metrics/history` consumer.

## Why these are shared

- The bridge-method allowlist must be enforced identically in [`apps/bridge`](../bridge/README.md) (Go) and the TS clients in [`bridge-client`](../bridge-client/README.md). The Go side hardcodes the list; the TS side imports from here. The end-to-end suite ([`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts)) cross-checks every method on the actual socket.
- Permission keys are written into RBAC route configs and the DB seed. Drift would silently break authorization.
- `ROLE_COLORS` must match the `roles_color_palette` SQL CHECK constraint; the `role-colors.test.ts` suite validates this automatically.
- `HOT_RELOAD_FILES` decides whether a config save triggers a "restart required" banner in the web UI.

## Adding a new permission key

1. Append an entry to `PERMISSIONS` in [`packages/shared-config/src/permissions.ts`](../../../packages/shared-config/src/permissions.ts).
2. The `PermissionKey` union type and `PERMISSION_KEYS` array are derived automatically.
3. Reference the new key in route `config.permissions` arrays in `apps/api`.

See [`architecture/rbac.md`](../../architecture/rbac.md) for the full enforcement model.

## Adding a new bridge method

See [`components/bridge/api.md`](../bridge/api.md#adding-a-new-method).
