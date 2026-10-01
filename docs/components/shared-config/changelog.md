# `shared-config` — changelog

## 2026-09-30 — Discord template shape validation (#78)

### Added

- `isDiscordEmbedTemplate(value)` in `discord-template.ts`: a structural check of a template's jsonb value for consumers without zod (the discord worker). Test: `test/discord-template.test.ts`.

## 2026-09-30

### Changed

- `stryker.config.json` (#79, finding 1164): `thresholds.break` is `70` instead of `0`, so the mutation job fails on a score regression. Measured score of the full run: 72.32%.

## 2026-09-27 — API route audit (#38)

### Added

- `outbound-url.ts`: `checkOutboundUrl()` and `isPublicUnicastAddress()` — the outbound request policy for ban source URLs (audit #100). The API checks the URL on write; `worker-ban-sync` checks it before every request, every redirect and on every connection.
- The `ban_source:view` permission (category `moderation`) for reading `/api/v1/ban-sources`.
- `isSafeBannedNameRegex()` and `BANNED_NAME_NICK_MAX = 64` (audit #115): `validateBannedNamePattern` rejects a regex with a repeatable group that contains a quantifier or `|`, and regexes with backreferences (`pattern_unsafe_regex`); `matchBannedName` and the `worker-log-ingest` matcher do not execute such rules even if they were saved earlier.

### Changed

- `trigger:view` is no longer marked `unimplemented`: it now protects `GET /api/v1/automation-rules` and `GET /api/v1/automation-runs`.


## 2026-09-28

### Fixed

- `selectNextLayer` sorts candidates by layer before the weighted pick: for a given seed the pick no longer depends on candidate order, and the preview matches the scheduler tick (#301).

## 2026-09-28

### Removed

- `process_info`, `file_read_tail` and `file_write` from `BRIDGE_METHODS` (#45) — no production caller; `process_info` exposed any host process's command line. The allowlist now has 27 methods.

## 2026-09-28 (#52)

### Security

- New `regex-safety.ts`: `detectDangerousRegex(pattern)` rejects variable-length nested quantifiers (`(a+)+`, `(.*a){20}`, `(a{1,100}){1,100}`), repeated alternation with overlapping branches (`(a|aa)+`, `(\w|\d)+`; only alternation of literals without common prefixes such as `(bad|worse)+` is allowed) and repeats above 100. Error codes: `nested_quantifier`, `alternation_under_quantifier`, `repeat_too_large`.
- `validateBannedNamePattern` now checks nickname regex rules with this scanner (previously only compilation), and `validateChatFlagPattern` uses the shared scanner. `matchBannedName` and `compileChatFlagRule` do not execute a dangerous pattern that was saved before the check.

### Fixed

- `renderDiscordTemplate`: values are taken only from the context's own string properties — `{constructor}`, `{__proto__}` and the like are treated as missing and no longer crash the render. An empty field name or value is replaced with `—` (`DISCORD_EMPTY_FIELD_VALUE`), and the text is truncated to the Discord limits (`DISCORD_EMBED_LIMITS`, 6000 characters in total) so that Discord does not answer 400.

## 2026-07-27

### Added

- `createGracefulShutdownController()` for workers: an early signal is kept until startup completes, a repeated signal joins the cleanup that has already started, and a cleanup error results in exit code `1`.
- Regression tests for an early signal, a repeated signal and a cleanup error.

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
