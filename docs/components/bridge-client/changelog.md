# `bridge-client` — changelog

## 2026-04-28

### Added

- Transparent transport-level retry for idempotent unary RPCs. When a call rejects with `BridgeError('transport', …)` — socket closed by peer, frame-decode error, write error — the client drops the broken socket, reconnects, and re-issues the request exactly once. Applied to `ping`, `hostInfo`, `hostMetrics`, `processInfo`, `fileRead`, `fileAtomicWrite`, `directoryDelete`, `listPanelDirs`, `listSquadContainers`, `ufwRule`, `containerInspect`, `containerStats`. Streaming methods and state-changing lifecycle RPCs (`containerRun/Start/Stop/Rm`, `hostAgentRestart`, `fileWrite`) are intentionally **not** retried.
- `retryOnTransport` opt-in flag in the internal `call()` options.
- `test/lifecycle.test.ts`: 4 new tests covering retry success, fileRead retry path, non-idempotent no-retry guarantee, and double-failure propagation.

### Fixed

- Routine `panel-host-bridge` restarts (or any single-call socket drop) no longer surface as a `socket closed` error to workers and the API. The previous behaviour caused `worker-config-sync` to publish `state: 'unreachable'` for at least 60 seconds (until the reclaim sweep kicked in) and forced the operator to click "Повторить синхронизацию" manually.

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
