# `bridge-client` — changelog

## 2026-07-07

### Added

- `BridgeClient.squadLogRetentionSweep(): Promise<SquadLogRetentionSweepResult>` wraps the new `squad_log_retention_sweep` RPC without params. Timeout: 60 s.
- `SquadLogRetentionSweepResult` and `SquadLogRetentionSweepError` exported from `packages/bridge-client/src/types.ts`.
- Round-trip tests assert the method id, omitted params, and result counters.

### Notes

- The method is intentionally not transport-retried so a lost response cannot turn into misleading deletion counters. The worker retries naturally on the next hourly tick.

## 2026-04-28

### Added

- Transparent transport-level retry for idempotent unary RPCs. When a call rejects with `BridgeError('transport', …)` — socket closed by peer, frame-decode error, write error — the client drops the broken socket, reconnects, and re-issues the request exactly once. Applied to `ping`, `hostInfo`, `hostMetrics`, `processInfo`, `fileRead`, `fileAtomicWrite`, `directoryDelete`, `listPanelDirs`, `listSquadContainers`, `ufwRule`, `containerInspect`, `containerStats`. Streaming methods and state-changing lifecycle RPCs (`containerRun/Start/Stop/Rm`, `hostAgentRestart`, `fileWrite`) are intentionally **not** retried.
- `retryOnTransport` opt-in flag in the internal `call()` options.
- `test/lifecycle.test.ts`: 4 new tests covering retry success, fileRead retry path, non-idempotent no-retry guarantee, and double-failure propagation.

### Fixed

- Routine `panel-host-bridge` restarts (or any single-call socket drop) no longer surface as a `socket closed` error to workers and the API. The previous behaviour caused `worker-config-sync` to publish `state: 'unreachable'` for at least 60 seconds (until the reclaim sweep kicked in) and forced the operator to click "Повторить синхронизацию" manually.
## 2026-04-29 — `fileReadTail` for bounded last-N-bytes reads

### Added

- `BridgeClient.fileReadTail({ path, max_bytes? }): Promise<FileReadTailResult>` — wraps the new `file_read_tail` RPC. Reads up to `max_bytes` from the end of an allowlisted file with newline-snap so the tail never starts mid-line. Default `max_bytes` is 64 KiB; values outside `(0, 1 MiB]` snap to the default on the bridge side.
- `FileReadTailParams` and `FileReadTailResult` exports in `packages/bridge-client/src/types.ts`. Result fields: `content` (string), `offset` (number, byte offset of `content` in the source file), `size` (number, total file size), `truncated` (boolean, `true` iff some prefix was skipped).
- `packages/bridge-client/test/lifecycle.test.ts` — round-trip case (`describe('file_read_tail')`) asserts the client serializes `method=file_read_tail` and the params shape on the wire and surfaces the result fields verbatim.

### Notes

- This is the client half of Task 18 (Phase A3) of `docs/superpowers/plans/2026-04-28-diagnostic-bundle.md`. Bridge handler + shared-config allowlist bump in the same commit.

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
