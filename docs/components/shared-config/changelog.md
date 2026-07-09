# `shared-config` — changelog

## 2026-07-07

### Added

- `squad_log_retention_sweep` appended to `BRIDGE_METHODS` before `host_agent_restart`. Backs LOG-1 raw Squad log retention through the host bridge.

### Changed

- `BRIDGE_METHODS` length is now 25. `BridgeMethod` union is correspondingly wider.

## 2026-04-29

### Added
- `file_read_tail` inserted into `BRIDGE_METHODS` (between `file_read` and `file_write`) — 20th allowed RPC method. Backs the diagnostic-bundle builder's bounded tail-read of `SquadGame.log`.

### Changed
- `BRIDGE_METHODS` length is now 20 (was 19). `BridgeMethod` union is correspondingly wider.

## 2026-04-28

### Added
- `panel_disk_usage` appended to `BRIDGE_METHODS` (between `depot_update` and `host_agent_restart`). Backs the host-disk-breakdown UI.

## 2026-04-26

### Added
- `packages/shared-config/test/property/registry.test.ts` — property-based tests (3 properties, 100 runs each) for `isPermissionKey` and `PERMISSION_KEYS` registry consistency.

## 2026-04-25

### Added
- `host:manage` permission key (category `host`, dangerous) for bridge restart capability.
- Full 8/8 component documentation (api, data-model, flows, configuration, testing, troubleshooting, changelog).

### Changed
- `PERMISSIONS` registry refactored to `satisfies readonly PermissionDef[]` for stricter TypeScript inference.
- `ROLE_COLORS` palette finalized to 16 Tailwind color names; `ROLE_COLOR_SET` added for O(1) guard; `isRoleColor` added.
- Sub-path exports `./role-colors` and `./permissions` added to `package.json` for browser-safe imports.

## 2025-11-15

### Added
- `log-stream-sink.ts` — pino multistream sink that writes to `panel:logs` Redis Stream.
- `metrics-pack.ts` — `packHostMetrics`/`unpackHostMetrics` for compact Redis Stream storage; `HOST_METRICS_STREAM`, `HOST_METRICS_MAXLEN` constants.
- `rcon-host.ts` — `resolveRconHost` for environment-aware RCON host resolution.
- Docker/container-related constants: `SERVER_IMAGE`, `DEPOT_INIT_IMAGE`, `DEPOT_VOLUME_NAME`, `SERVER_CONTAINER_PREFIX`, `SERVER_CONTAINER_REGEX`.
- Config file classification: `ALLOWED_CONFIG_FILES`, `HOT_RELOAD_FILES`, `ROTATION_FILES`, `configFileClass()`.
- `BRIDGE_STREAMING_METHODS` to distinguish streaming RPC from unary.

### Changed
- `BRIDGE_METHODS` updated to replace pre-container methods with Docker-based ones (`container_run`, `container_start`, etc.).

## 2025-09-01

### Added
- Initial package: `bridge-methods.ts` (method allowlist, socket/frame constants), `heartbeat.ts` (worker heartbeat helper), `log-stream.ts` (encode/decode, source/level codes), `permissions.ts` (PERMISSIONS registry, 44 initial keys).
