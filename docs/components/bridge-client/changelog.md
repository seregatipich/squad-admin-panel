# `bridge-client` — changelog

## 2026-04-28 — `panelDiskUsage` accepts `{ force?: boolean }`

### Changed
- `panelDiskUsage(opts?: { force?: boolean })` — passing `{ force: true }` forwards a `{ force: true }` params payload to the bridge, instructing it to skip the 5-minute cache and recompute. With no argument the client still sends `params: {}` (existing behaviour preserved).
- `packages/bridge-client/test/lifecycle.test.ts` — extended the existing `panel_disk_usage` round-trip test to assert the no-arg call sends `params: {}` and added a second case proving the `{ force: true }` invocation forwards the flag.

## 2026-04-28

### Added
- `panelDiskUsage()` method bound to the new `panel_disk_usage` RPC. Returns a `PanelDiskUsage` breakdown of configs/saved/depot/docker/audit-archive bytes plus host filesystem totals. Timeout: 30 s.
- `PanelDiskUsage`, `PanelDiskUsageDockerVolume`, `PanelDiskUsageDockerImage`, `PanelDiskUsageSavedEntry` exported from `@squad/bridge-client`.

## 2026-04-25

### Added
- Full 8/8 component documentation (api, data-model, flows, configuration, testing, troubleshooting, changelog).

## 2025-11-15

### Changed
- Migrated from systemd-unit and apt-install based server management to Docker container model. `containerRun`, `containerStart`, `containerStop`, `containerRm`, `containerInspect`, `containerStats`, `containerLogsFollow` methods added; old `service_*` and `apt_*` methods removed.
- `depotUpdate` now streams output from a transient `squad-panel/depot-init` container instead of running SteamCMD directly on the host.
- Per-WebSocket client pattern introduced (`app.makeBridgeClient()`) to prevent long-running `containerLogsFollow` streams from starving sibling unary calls on the shared `app.bridge` instance.

### Fixed
- `attachHandlers` decode-error path no longer sets `closed = true`. Previously, a single framing error permanently wedged the client; now the socket is dropped and the next call reconnects transparently.

## 2025-09-01

### Added
- Initial implementation: `BridgeClient` class, 4-byte length-prefix framing (`encodeFrame`/`decodeFrames`), UUIDv7 request IDs, `BridgeError` with typed error codes.
- `hostInfo`, `hostMetrics`, `fileRead`, `fileWrite`, `fileAtomicWrite`, `ufwRule`, `processInfo`, `ping` methods.
- `hostAgentRestart` method for triggering bridge self-restart via systemd.
