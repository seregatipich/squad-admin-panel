# `bridge-client` — changelog

## 2026-04-28 — `BridgeClient` extends `EventEmitter` — `connected` / `disconnected` / `rpc-error` / `rtt` events

### Added

- `BridgeClient` now extends `EventEmitter` (typed via an internal `TypedEmitter<BridgeClientEvents>` wrapper). Four events are emitted:
  - `connected` (`{ rttMs, version, hostname }`) — fired after the first successful `ping()` response on a freshly-opened socket. Fires at most once per socket; a reconnect re-arms it.
  - `disconnected` (`'socket-error' | 'socket-closed' | 'frame-decode-error' | 'client-closed'`) — fired only if a `connected` event was previously emitted for that socket; the on-the-wire close that follows a never-handshaked connection stays silent.
  - `rpc-error` (`{ method, code, message }`) — fired after every `ok: false` response, immediately before the call promise rejects with `BridgeError(code, message)`.
  - `rtt` (`rttMs: number`) — fired after every successful (ok=true) response. Streaming methods only emit this for the terminal exit-code response, not per-frame.
- New exported types: `BridgeClientEvents`, `BridgeClientConnectedInfo`, `BridgeClientRpcErrorInfo`, `BridgeClientDisconnectReason`.
- `packages/bridge-client/test/lifecycle.test.ts` — six new event-emission cases (connected once per socket, no double-emit on back-to-back pings, rtt sample per RPC, rpc-error on non-ok response, disconnected on `close()`, disconnected on oversized-frame decode error).
- API consumer in [`apps/api/src/plugins/bridge.ts`](../../../apps/api/src/plugins/bridge.ts) translates each event into a `bridge.client.connected` / `bridge.client.disconnected` / `bridge.rpc.error` / `bridge.rtt.outlier` (only above 50ms) diag emit. Listener-side `app.diag.emit` rejections are swallowed via `.catch(() => undefined)` so a Redis hiccup never propagates back into the bridge layer.

### Changed

- `PendingCall` (private) gained `method` and `startedAt` fields so the response handler can recover the RPC method name and compute RTT for the new events.
- `attachHandlers` and `close()` now track `hasEmittedConnectedForCurrentSocket` so the `disconnected` event matches a prior `connected` event one-for-one. A close on a socket that never received a successful ping stays silent.

### Migration notes

No breaking changes — all events are additive and existing `BridgeClient` consumers that ignore them keep working. The class signature changed from `class BridgeClient` to `class BridgeClient extends EventEmitter` (exposed as `TypedEmitter<BridgeClientEvents>`); subclassers using `extends BridgeClient` should not see a behavioural change but inherit the four typed event channels.

## 2026-04-28 — `ContainerInspectResult` gains optional `oom_killed` / `error`

### Changed
- `ContainerInspectResult` (in [`packages/bridge-client/src/types.ts`](../../../packages/bridge-client/src/types.ts)) declares two new optional fields: `oom_killed?: boolean` and `error?: string`. Mirrors Docker's `State.OOMKilled` and `State.Error`. The Go bridge does not yet populate either field; the wire format reserves them so the API status reconciler can emit `container.exited` diag events with structured exit metadata once the Go side wires up the mapping. Consumers must default missing values to `false` and `null` respectively. No breaking change — both fields are optional, all existing call sites keep working.

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
