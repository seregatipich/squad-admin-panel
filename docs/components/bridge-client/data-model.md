# `bridge-client` — data model

Source files:
- [`packages/bridge-client/src/types.ts`](../../../packages/bridge-client/src/types.ts)
- [`packages/bridge-client/src/frame.ts`](../../../packages/bridge-client/src/frame.ts)

## Wire frame format

Every message in both directions is framed identically: a 4-byte big-endian unsigned integer giving the body length, followed by a UTF-8 JSON body.

```
┌────────────────────────┬────────────────────────────────────────┐
│  length (4 bytes, BE)  │  JSON body (length bytes, UTF-8)       │
└────────────────────────┴────────────────────────────────────────┘
```

- Maximum frame size: **16 MiB** (`BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024`). Frames exceeding this limit throw `FrameTooLargeError` on encode and on decode.
- The client accumulates partial frames in an internal `Buffer` and only processes complete frames.

## Request shape (`BridgeRequest`)

```ts
interface BridgeRequest<Params = unknown> {
  id: string;        // UUIDv7 — used to correlate responses
  method: BridgeMethod;
  params?: Params;
}
```

`method` must be one of the 19 values in `BRIDGE_METHODS` (see [`shared-config/api.md`](../shared-config/api.md)).

## Response shape (`BridgeResponse`)

```ts
interface BridgeResponse<Result = unknown> {
  id: string;        // mirrors request id
  ok: boolean;
  result?: Result;   // present when ok === true
  error?: {
    code: BridgeErrorCode;
    message: string;
    detail?: unknown;
  };
}
```

## Stream frame shape (`BridgeStreamFrame`)

Sent by the bridge for streaming methods (`container_logs_follow`, `depot_update`) between the first response byte and the final response.

```ts
interface BridgeStreamFrame<Data = unknown> {
  id: string;                          // same id as the originating request
  stream: 'stdout' | 'stderr' | 'event';
  data: Data;
}
```

The client dispatches stream frames to `PendingCall.onStream` without removing the pending entry. The final `BridgeResponse` (with `ok` and `result.exit_code`) settles the promise.

## Error codes (`BridgeErrorCode`)

```ts
type BridgeErrorCode =
  | 'forbidden'      // path/image outside allowlist
  | 'invalid_args'   // missing or malformed params
  | 'runtime_error'  // Docker CLI or OS command failure
  | 'timeout'        // client-side deadline exceeded
  | 'internal'       // unexpected Go error
  | 'transport';     // socket-level error
```

## Method-specific result types

### `PingResult`

```ts
{ pong: true; version: string; hostname: string }
```

### `HostInfo`

```ts
{
  hostname: string; os_name: string; os_version: string;
  kernel: string; arch: string; cpu_model: string;
  cpu_cores: number; ram_total_bytes: number; uptime_seconds: number;
  docker_version: string; ip_addresses: string[];
}
```

### `HostMetrics`

```ts
{
  cpu_percent: number; ram_used_bytes: number; ram_total_bytes: number;
  disk_used_bytes: number; disk_total_bytes: number;
  net_rx_bytes_per_sec: number; net_tx_bytes_per_sec: number;
  load_avg_1m: number; load_avg_5m: number; load_avg_15m: number;
  sampled_at: string;  // ISO-8601 UTC
}
```

### `ContainerRunResult`

```ts
{ container_id: string; status: 'started' }
```

### `ContainerInspectResult`

```ts
{
  name: string; state: string; running: boolean; pid: number;
  started_at: string; finished_at: string; exit_code: number;
  image: string; restart_count: number; labels: Record<string, string>;
}
```

### `ContainerStatsResult`

```ts
{
  name: string; found: boolean; cpu_percent: number;
  mem_used_bytes: number; mem_limit_bytes: number; mem_percent: number;
  pids: number; sampled_at: string;
}
```

### `ProcessInfoResult`

```ts
{
  pid: number; exists: boolean;
  rss_bytes?: number; vsz_bytes?: number;
  cmdline?: string; state?: string; threads?: number;
}
```

### `HostAgentRestartResult`

```ts
{ status: 'restarting' }
```

### `PanelDiskUsage`

```ts
{
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;        // ISO-8601 UTC
  cache_age_seconds: number;  // 0 when freshly computed
}
```

## Params types

### `FileReadParams`

```ts
{ path: string }
```

### `FileWriteParams`

```ts
{ path: string; content: string; mode?: number }
```

### `UfwRuleParams`

```ts
{ action: 'add' | 'remove'; port: number; proto: 'tcp' | 'udp'; comment?: string }
```

### `ProcessInfoParams`

```ts
{ pid: number }
```

### `ContainerControlParams`

```ts
{ name: string; timeout_sec?: number }
```

### `ContainerLogsParams`

```ts
{ name: string; tail?: number }
```

### `ContainerRunParams`

See `api.md` — the longest params struct; 14 fields covering ports, volume mounts, and resource limits.
