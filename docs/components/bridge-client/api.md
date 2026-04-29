# `bridge-client` — API reference

Source: [`packages/bridge-client/src/`](../../../packages/bridge-client/src/)

## `BridgeClient`

Constructed with optional `BridgeClientOptions`. All RPC methods auto-connect on first call.

```ts
import { BridgeClient } from '@squad/bridge-client';

const client = new BridgeClient({ socketPath: '/run/panel-host-bridge.sock' });
```

### Constructor options

| Option | Type | Default | Description |
|---|---|---|---|
| `socketPath` | `string` | `BRIDGE_SOCKET_DEFAULT` (`/run/panel-host-bridge.sock`) | Unix socket path |
| `defaultTimeoutMs` | `number` | `15_000` | Timeout for unary calls. Streaming calls set their own. |
| `onLog` | `(msg, meta?) => void` | no-op | Receives structured log lines; wire into pino or console |

---

### `connect(): Promise<void>`

Opens the Unix socket. Idempotent — safe to call multiple times; a pending connection is shared. Called automatically by any RPC method if the socket is not yet open.

---

### `close(): Promise<void>`

Gracefully closes the socket. Rejects all in-flight calls with `BridgeError('transport', 'client closed')`. Sets `closed = true`, preventing any future calls from reconnecting.

Do **not** call on the shared `app.bridge` instance from inside a per-request handler — use `app.makeBridgeClient()` for connections that should be closed per WebSocket.

---

### Unary methods

Each returns a `Promise` that resolves with the typed result or rejects with a `BridgeError`.

#### `ping(): Promise<PingResult>`

```ts
const { pong, version, hostname } = await client.ping();
```

| Field | Type |
|---|---|
| `pong` | `true` |
| `version` | `string` — bridge binary version |
| `hostname` | `string` |

---

#### `hostInfo(): Promise<HostInfo>`

Returns static host metadata.

| Field | Type |
|---|---|
| `hostname` | `string` |
| `os_name` | `string` |
| `os_version` | `string` |
| `kernel` | `string` |
| `arch` | `string` |
| `cpu_model` | `string` |
| `cpu_cores` | `number` |
| `ram_total_bytes` | `number` |
| `uptime_seconds` | `number` |
| `docker_version` | `string` |
| `ip_addresses` | `string[]` |

---

#### `hostMetrics(): Promise<HostMetrics>`

Returns a live metrics snapshot. `sampled_at` is ISO-8601 UTC.

| Field | Type |
|---|---|
| `cpu_percent` | `number` |
| `ram_used_bytes` | `number` |
| `ram_total_bytes` | `number` |
| `disk_used_bytes` | `number` |
| `disk_total_bytes` | `number` |
| `net_rx_bytes_per_sec` | `number` |
| `net_tx_bytes_per_sec` | `number` |
| `load_avg_1m/5m/15m` | `number` |
| `sampled_at` | `string` |

---

#### `fileRead(p: FileReadParams): Promise<{ content: string }>`

Reads an allowlisted config file. `path` must resolve inside `/var/lib/squad-panel/configs/{uuid}/ServerConfig/` or the saved path.

```ts
const { content } = await client.fileRead({ path: '/var/lib/squad-panel/configs/<uuid>/ServerConfig/Server.cfg' });
```

Throws `BridgeError('forbidden')` if the path is outside the allowlist.

---

#### `fileReadTail(p: FileReadTailParams): Promise<FileReadTailResult>`

Reads up to `max_bytes` from the **end** of an allowlisted file. When the file is larger than `max_bytes` the read snaps forward to the next `\n` so the result never starts mid-line. Used by the diagnostic-bundle builder to capture the tail of `SquadGame.log` without slurping multi-MB files.

```ts
interface FileReadTailParams {
  path: string;
  max_bytes?: number; // default 65536, max 1 MiB
}

interface FileReadTailResult {
  content: string;
  offset: number;     // byte offset where `content` starts in the source file
  size: number;       // total file size in bytes at read time
  truncated: boolean; // true iff size > max_bytes (some prefix was skipped)
}
```

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| `path` | `string` | yes | — | Same allowlist as `fileRead`. |
| `max_bytes` | `number` | no | `65536` | Values `<= 0` or `> 1048576` snap to the default. |

```ts
const tail = await client.fileReadTail({
  path: '/var/lib/squad-panel/saved/<uuid>/SquadGame/Saved/Logs/SquadGame.log',
  max_bytes: 65536,
});
// { content, offset: 12516352, size: 12582912, truncated: true }
```

Throws `BridgeError('forbidden')` if the path is outside the allowlist, `BridgeError('runtime_error')` if the file cannot be opened/seeked.

---

#### `fileWrite(p: FileWriteParams): Promise<{ status: string }>`

Writes a file with standard `os.WriteFile`. Not atomic — use `fileAtomicWrite` for config edits.

| Param | Type | Required |
|---|---|---|
| `path` | `string` | yes |
| `content` | `string` | yes |
| `mode` | `number` | no (defaults to `0644`) |

---

#### `fileAtomicWrite(p: FileWriteParams): Promise<{ status: string }>`

Writes via a temp-file rename (atomic on Linux ext4/XFS). Creates intermediate directories up to the allowed root. Use this for all config-editor saves.

---

#### `ufwRule(p: UfwRuleParams): Promise<{ output: string; status: string }>`

Adds or removes a UFW firewall rule.

| Param | Type | Values |
|---|---|---|
| `action` | `'add' \| 'remove'` | |
| `port` | `number` | 1–65535 |
| `proto` | `'tcp' \| 'udp'` | |
| `comment` | `string` | optional |

---

#### `processInfo(p: ProcessInfoParams): Promise<ProcessInfoResult>`

Reads `/proc/{pid}/` data.

```ts
const info = await client.processInfo({ pid: 12345 });
// { pid, exists, rss_bytes?, vsz_bytes?, cmdline?, state?, threads? }
```

---

#### `containerRun(p: ContainerRunParams): Promise<ContainerRunResult>`

Spawns a new Squad server container. Timeout: 60 s.

| Param | Type | Notes |
|---|---|---|
| `server_id` | `string` | UUID — sets the container name to `squad-{server_id}` |
| `image` | `string` | Must be `squad-server:latest` or `squad-panel/depot-init:latest` |
| `game_port` | `number` | |
| `query_port` | `number` | |
| `beacon_port` | `number` | |
| `rcon_port` | `number` | |
| `max_players` | `number` | optional, default 100 |
| `tickrate` | `number` | optional, default 50 |
| `multihome` | `string \| null` | optional bind address |
| `extra_args` | `string[]` | optional additional launch args |
| `configs_host` | `string` | host path for ServerConfig bind-mount |
| `saved_host` | `string` | host path for Saved bind-mount |
| `depot_volume` | `string` | named volume for the SteamCMD depot |
| `ulimit_nofile` | `number` | optional open-file ulimit |

Returns `{ container_id: string; status: 'started' }`.

---

#### `containerStart(p: ContainerControlParams): Promise<{ status: string }>`

Starts a stopped container. Timeout: 30 s.

```ts
await client.containerStart({ name: 'squad-01903f7d-...', timeout_sec: 10 });
```

---

#### `containerStop(p: ContainerControlParams): Promise<{ status: string }>`

Gracefully stops a running container. Timeout: 120 s.

---

#### `containerRm(p: ContainerControlParams): Promise<{ status: string }>`

Removes a stopped container. Timeout: 30 s.

---

#### `containerInspect(p: ContainerControlParams): Promise<ContainerInspectResult>`

Returns Docker inspect data. Timeout: 10 s.

```ts
const { running, state, pid, exit_code } = await client.containerInspect({ name: 'squad-01903f7d-...' });
```

---

#### `containerStats(p: ContainerControlParams): Promise<ContainerStatsResult>`

Returns a live CPU/memory snapshot for a running container. Timeout: 10 s.

```ts
const { cpu_percent, mem_used_bytes, mem_limit_bytes } = await client.containerStats({ name: 'squad-01903f7d-...' });
```

---

#### `panelDiskUsage(opts?: { force?: boolean }): Promise<PanelDiskUsage>`

Returns a structured breakdown of the panel's disk footprint on the host. The Go-side computation lives in `apps/bridge/internal/handlers/handlers.go` (`panelDiskUsage`) and combines `du -sb` walks of the panel data root, a panel-owned filter on `docker system df`, and `syscall.Statfs` for whole-host capacity; results are cached inside the bridge for 5 minutes. E2E coverage against the live socket is in `apps/api/test/e2e/bridge-rpc.e2e.test.ts` (shape assertions plus a caching idempotence case). Timeout: 30 s.

Pass `{ force: true }` to bypass the 5-minute bridge-side cache and force a fresh `du`/`docker df`/`statfs` recompute. The fresh result is still written back into the cache so the next non-force call sees it immediately. The API surfaces this as `?refresh=1` on `GET /api/v1/host/disk-usage`. With no argument or `{}`, the client sends `params: {}` and the bridge returns a cached result if one is fresh enough.

| Field | Type | Description |
|---|---|---|
| `configs_bytes` | `number` | Bytes used by `/var/lib/squad-panel/configs/` |
| `saved_total_bytes` | `number` | Bytes used by `/var/lib/squad-panel/saved/` |
| `saved_per_server` | `{ uuid: string; bytes: number }[]` | Per-server breakdown of `saved/` (one entry per uuid sub-directory) |
| `depot_volume_bytes` | `number` | Size of the `squad-depot` named volume |
| `docker_volumes` | `{ name: string; bytes: number }[]` | Other panel-owned Docker volumes |
| `docker_images` | `{ repository: string; tag: string; bytes: number }[]` | Squad-related Docker images |
| `audit_archive_bytes` | `number` | Bytes used by the audit-archive directory |
| `total_panel_bytes` | `number` | Sum of all panel-owned categories |
| `host_total_bytes` | `number` | Total bytes on the filesystem hosting `/var/lib/squad-panel` |
| `host_used_bytes` | `number` | Used bytes on that filesystem |
| `computed_at` | `string` | ISO-8601 timestamp at which the bridge gathered the figures |
| `cache_age_seconds` | `number` | Age of the cached result in seconds (0 = fresh) |

```ts
const usage = await client.panelDiskUsage();
const panelShareOfHost = usage.total_panel_bytes / usage.host_total_bytes;

const fresh = await client.panelDiskUsage({ force: true });
console.log(fresh.cache_age_seconds); // 0
```

---

#### `hostAgentRestart(): Promise<HostAgentRestartResult>`

Asks the bridge to restart itself via systemd. Returns `{ status: 'restarting' }` before the socket closes. Timeout: 5 s.

---

### Streaming methods

Streaming calls accept an `onStream` callback that receives `BridgeStreamFrame` objects. The returned `Promise` resolves when the process exits.

#### `containerLogsFollow(p: ContainerLogsParams, onStream): Promise<{ exit_code: number }>`

Tails Docker logs for a running container in real-time. Timeout: `Infinity` — call `client.close()` to abort.

```ts
const done = client.containerLogsFollow(
  { name: 'squad-01903f7d-...', tail: 200 },
  (frame) => {
    // frame.stream: 'stdout' | 'stderr' | 'event'
    ws.send(JSON.stringify(frame.data));
  },
);
```

Use `app.makeBridgeClient()` — not the shared `app.bridge` — for this call. A long-running stream on the shared client starves sibling unary calls.

#### `depotUpdate(onStream): Promise<{ exit_code: number }>`

Spawns a transient `squad-panel/depot-init` container running `steamcmd +app_update 403240 validate`. Streams stdout/stderr. Timeout: 1 hour.

```ts
const done = client.depotUpdate((frame) => {
  installSocket.send(frame.data);
});
```

---

## Events

`BridgeClient` extends `EventEmitter`. Subscribers attach via the standard `on(event, handler)` / `off(event, handler)` API. All events are fire-and-forget — listener exceptions are caught and routed to `onLog`; the RPC dispatcher and reconnection logic do not depend on listener return values.

```ts
import { BridgeClient } from '@squad/bridge-client';

const client = new BridgeClient({ socketPath: '/run/panel-host-bridge.sock' });
client.on('connected', (info) => console.log('bridge up', info));
client.on('disconnected', (reason) => console.warn('bridge down', reason));
client.on('rpc-error', ({ method, code, message }) => console.warn(method, code, message));
client.on('rtt', (ms) => { if (ms > 50) console.warn('slow RPC', ms); });
```

| Event | Args | When fired |
|---|---|---|
| `connected` | `{ rttMs: number; version: string; hostname: string }` | After the **first successful `ping()` response on a freshly-opened socket** — not on raw socket connect. The `version` and `hostname` fields are read from the ping result; `rttMs` is `Date.now() - request_started_at`. Fires at most once per socket lifetime; reconnect re-arms it. |
| `disconnected` | `reason: 'socket-error' \| 'socket-closed' \| 'frame-decode-error' \| 'client-closed'` | Fired only if a `connected` event was previously emitted for the current socket — disconnects on a never-handshaked socket are silent. `client-closed` fires from `close()`; the other reasons fire from socket-level events / framing failures. |
| `rpc-error` | `{ method: string; code: BridgeErrorCode; message: string }` | After every response with `ok: false`. The corresponding `call()` promise rejects with `BridgeError(code, message)` immediately afterwards. Use this for per-method error counters / structured logging. |
| `rtt` | `rttMs: number` | After every successful (ok=true) response. `rttMs` is the wall-clock delay between dispatch and response handling. Streaming methods (`containerLogsFollow`, `depotUpdate`) only emit this when the final exit-code response arrives — per-frame RTT is not tracked. |

The api wires these into `app.diag.emit` from [`apps/api/src/plugins/bridge.ts`](../../../apps/api/src/plugins/bridge.ts) so they show up as `bridge.client.connected` / `bridge.client.disconnected` / `bridge.rpc.error` / `bridge.rtt.outlier` (only when `rttMs > 50`) entries in the `diag:queue` Redis Stream. See [`docs/components/api/api.md`](../api/api.md#bridge-listener-event-kinds) for the API-side mapping.

---

## `BridgeError`

Thrown by every RPC method on failure.

```ts
import { BridgeError } from '@squad/bridge-client';

try {
  await client.fileRead({ path: '/etc/passwd' });
} catch (err) {
  if (err instanceof BridgeError) {
    console.error(err.code, err.message, err.detail);
  }
}
```

| `code` | Meaning |
|---|---|
| `forbidden` | Path or image outside the allowlist |
| `invalid_args` | Missing or malformed params |
| `runtime_error` | Docker CLI or OS command failed |
| `timeout` | Client-side deadline exceeded |
| `internal` | Unexpected Go-side error |
| `transport` | Socket-level error (connect failed, closed) |

---

## `encodeFrame` / `decodeFrames`

Low-level framing utilities exported from `@squad/bridge-client` for tests. Production code uses these internally.

```ts
import { encodeFrame, decodeFrames, FrameTooLargeError } from '@squad/bridge-client';

const buf = encodeFrame({ id: 'x', method: 'ping' });
const { frames, remainder } = decodeFrames(buf);
```

Throws `FrameTooLargeError` if a payload exceeds `BRIDGE_MAX_FRAME_BYTES` (16 MiB).
