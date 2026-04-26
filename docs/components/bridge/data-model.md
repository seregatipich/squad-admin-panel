# Bridge — Data Model

The panel-host-bridge uses a custom binary framing protocol over a Unix domain socket. All data shapes are JSON.

---

## Wire framing

Source: `apps/bridge/internal/rpc/frame.go`.

Every message — request, response, and streaming frame — is prefixed with a 4-byte big-endian unsigned integer that specifies the payload length in bytes, followed immediately by the JSON payload.

```
| 4 bytes (uint32 BE) | N bytes (JSON) |
```

Maximum frame size: **16 MiB** (`MaxFrame = 16 << 20`). Frames larger than this are rejected with `ErrFrameTooLarge`.

---

## Request envelope

Source: `apps/bridge/internal/rpc/types.go`.

```json
{
  "id":     "req-1234",
  "method": "ping",
  "params": { ... }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Caller-assigned request identifier; echoed back in the response. |
| `method` | string | One of the 17 whitelisted RPC methods. |
| `params` | object (optional) | Method-specific parameters. Omitted for methods that take no params (e.g., `host_info`). |

---

## Response envelope

```json
{
  "id":     "req-1234",
  "ok":     true,
  "result": { ... },
  "error":  null
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Echoes the request id. |
| `ok` | bool | `true` on success, `false` on any error. |
| `result` | object \| null | Method-specific result object. Present only when `ok: true`. |
| `error` | ErrorObject \| null | Present only when `ok: false`. |

### `ErrorObject`

```json
{
  "code":    "forbidden",
  "message": "path \"/etc/passwd\" outside allowed roots",
  "detail":  null
}
```

| `code` | Meaning |
|---|---|
| `forbidden` | Path, image, or container name rejected by policy. |
| `invalid_args` | JSON unmarshal failure or missing required field. |
| `runtime_error` | OS-level or Docker CLI failure. |
| `timeout` | Operation exceeded its context deadline. |
| `internal` | Unexpected internal error. |

---

## Streaming frame

Produced by `container_logs_follow` and `depot_update` before the final response arrives. Frames are written to the same socket and interleaved with the regular length-prefix framing.

```json
{
  "id":     "req-1234",
  "stream": "stdout",
  "data":   "LogSquad: [2026.04.25-08.01.00:000][001]..."
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Matches the originating request id. |
| `stream` | string | `"stdout"` or `"stderr"`. |
| `data` | JSON-encoded string | Log line chunk. The value is a JSON string (double-quoted, escape-encoded). |

After all streaming frames the final response frame is written (same framing, `ok: true/false`, `result.exit_code`).

---

## Per-method param and result shapes

### `ping`

**Params:** none.

**Result:**
```json
{ "pong": true, "version": "1.2.3", "hostname": "panel-host" }
```

---

### `host_info`

**Params:** none.

**Result** (source: `apps/bridge/internal/metrics/host.go`, `HostInfo` struct):
```json
{
  "hostname":       "panel-host",
  "os_name":        "Ubuntu",
  "os_version":     "22.04",
  "kernel":         "5.15.0-101-generic",
  "arch":           "amd64",
  "cpu_model":      "Intel Core i9-13900K",
  "cpu_cores":      24,
  "ram_total_bytes": 34359738368,
  "uptime_seconds": 86400,
  "docker_version": "25.0.3",
  "ip_addresses":   ["192.168.1.100", "10.0.0.1"]
}
```

---

### `host_metrics`

**Params:** none.

**Result** (source: `HostMetrics` struct):
```json
{
  "cpu_percent":         12.5,
  "ram_used_bytes":      4294967296,
  "ram_total_bytes":     34359738368,
  "disk_used_bytes":     107374182400,
  "disk_total_bytes":    536870912000,
  "net_rx_bytes_per_sec": 1048576,
  "net_tx_bytes_per_sec": 524288,
  "load_avg_1m":         1.25,
  "load_avg_5m":         1.10,
  "load_avg_15m":        0.95,
  "sampled_at":          "2026-04-25T08:00:00Z"
}
```

`cpu_percent` is a two-interval CPU utilisation sample (0–100 float). `disk_*` values are measured at the root filesystem or the configured `DiskRoot`.

---

### `process_info`

**Params:**
```json
{ "pid": 12345 }
```

**Result:**
```json
{
  "pid":       12345,
  "exists":    true,
  "rss_bytes": 1073741824,
  "vsz_bytes": 4294967296,
  "cmdline":   "/squad/SquadGameServer.sh ...",
  "state":     "S (sleeping)",
  "threads":   64
}
```

When `exists: false` only `pid` and `exists` are populated.

---

### `file_read`

**Params:**
```json
{ "path": "/var/lib/squad-panel/configs/{uuid}/ServerConfig/Server.cfg" }
```

**Result:**
```json
{ "content": "[OnlineSubsystem]\nServerName=My Squad Server\n..." }
```

**Readable path allowlist:**
- `/var/lib/squad-panel/configs/{uuid}/ServerConfig/{file}.cfg` — all 19 allowed cfg files.
- `/var/lib/squad-panel/saved/{uuid}/` — Squad logs and workshop cache (any depth).
- Depot host path (default `/var/lib/docker/volumes/squad-depot/_data`, overridable via `PANEL_DEPOT_HOST_PATH`).
- `/var/lib/squad-panel/.first-owner-claimed` sentinel.

---

### `file_write`

**Params:**
```json
{
  "path":    "/var/lib/squad-panel/configs/{uuid}/ServerConfig/Admins.cfg",
  "content": "[AdminList]\n...",
  "mode":    420
}
```

`mode` is an octal file permission as a decimal integer (default 0644 = 420). Optional.

**Result:**
```json
{ "status": "written" }
```

**Writable path allowlist:**
- `/var/lib/squad-panel/configs/{uuid}/ServerConfig/{file}.cfg` — only the 19 allowed cfg files.
- `/var/lib/squad-panel/.first-owner-claimed` sentinel.

The depot path is **read-only** and not in the writable allowlist.

---

### `file_atomic_write`

Identical params and result to `file_write`. Uses a write-to-temp + rename pattern to ensure atomicity. Also calls `MkdirAll` up through the allowed root before writing.

---

### `ufw_rule`

**Params:**
```json
{
  "action":  "allow",
  "port":    7787,
  "proto":   "udp",
  "comment": "squad-{uuid}-game"
}
```

`action`: `"allow"` or `"delete"`. `proto`: `"tcp"`, `"udp"`, or `"tcp/udp"`. `port`: 1–65535.

**Result:**
```json
{ "output": "Rule added", "status": "done" }
```

---

### `container_run`

**Params:**
```json
{
  "server_id":    "0190abcd-...",
  "image":        "squad-server:latest",
  "game_port":    7787,
  "query_port":   27165,
  "beacon_port":  15000,
  "rcon_port":    21114,
  "max_players":  100,
  "tickrate":     50,
  "multihome":    "0.0.0.0",
  "extra_args":   [],
  "configs_host": "/var/lib/squad-panel/configs/{uuid}",
  "saved_host":   "/var/lib/squad-panel/saved/{uuid}",
  "depot_volume": "squad-depot",
  "ulimit_nofile": 65536
}
```

`server_id` must be a valid UUID v4/v7 (lowercase hex). `image` must be one of the two allowlisted images (see below). `configs_host` and `saved_host` must pass `PanelConfigsPath` and `PanelSavedPath` validation respectively. `depot_volume` must equal `"squad-depot"`.

**Result:**
```json
{ "container_id": "a1b2c3d4e5f6", "status": "started" }
```

---

### `container_start`

**Params:**
```json
{ "name": "squad-0190abcd-..." }
```

**Result:**
```json
{ "status": "started" }
```

---

### `container_stop`

**Params:**
```json
{ "name": "squad-0190abcd-...", "timeout_sec": 60 }
```

`timeout_sec` defaults to 60 when 0 or omitted. Docker sends SIGTERM first, then SIGKILL after the timeout.

**Result:**
```json
{ "status": "stopped" }
```

---

### `container_rm`

**Params:**
```json
{ "name": "squad-0190abcd-..." }
```

Runs `docker rm -f`. If the container does not exist the call succeeds silently.

**Result:**
```json
{ "status": "removed" }
```

---

### `container_inspect`

**Params:**
```json
{ "name": "squad-0190abcd-..." }
```

**Result:** JSON object matching Docker inspect output, including at minimum:

```json
{
  "state":         "running",
  "running":       true,
  "started_at":    "2026-04-25T06:00:00Z",
  "finished_at":   null,
  "image":         "squad-server:latest",
  "pid":           12345,
  "restart_count": 0,
  "exit_code":     0
}
```

---

### `container_stats`

**Params:**
```json
{ "name": "squad-0190abcd-..." }
```

**Result:** CPU and memory stats from `docker stats --no-stream`.

```json
{
  "cpu_percent":     12.5,
  "mem_used_bytes":  2147483648,
  "mem_limit_bytes": 8589934592
}
```

---

### `container_logs_follow`

**Params:**
```json
{ "name": "squad-0190abcd-...", "tail": 50 }
```

`tail`: number of historical lines to emit before live tailing. Default 0 (no history).

**Streaming frames:** one per log line, `stream: "stdout"` or `"stderr"`.

**Final result:**
```json
{ "exit_code": 0 }
```

`exit_code` reflects the Docker CLI exit code; it is 0 when the container exits cleanly or the context is cancelled.

---

### `depot_update`

**Params:** none.

Spawns a transient `squad-panel/depot-init:latest` container that runs `steamcmd +app_update 403240 validate` against the `squad-depot` named volume.

**Streaming frames:** stdout/stderr from the steamcmd session.

**Final result:**
```json
{ "exit_code": 0 }
```

---

### `host_agent_restart`

**Params:** none.

Schedules `systemctl restart panel-host-bridge.service` to run after a 250 ms flush delay, allowing the response frame to reach the client before systemd kills the process.

**Result:**
```json
{ "status": "restarting" }
```

---

## Path allowlists

Source: `apps/bridge/internal/validate/docker.go` and `apps/bridge/internal/validate/paths.go`.

### Readable paths

Any path that matches one of:
1. `/var/lib/squad-panel/configs/{uuid}/ServerConfig/{file}.cfg` where `{uuid}` matches `^[a-f0-9]{8}-...$` and `{file}` is in the cfg file allowlist.
2. `/var/lib/squad-panel/saved/{uuid}/` (any depth).
3. The depot host path: `/var/lib/docker/volumes/squad-depot/_data` by default, overridable by `PANEL_DEPOT_HOST_PATH` env var.
4. `/var/lib/squad-panel/.first-owner-claimed` (exact path).

### Writable paths

Only:
1. `/var/lib/squad-panel/configs/{uuid}/ServerConfig/{file}.cfg` — same cfg file allowlist as above.
2. `/var/lib/squad-panel/.first-owner-claimed` (exact path).

### Allowed cfg files (19 total)

`Admins.cfg`, `Bans.cfg`, `CustomOptions.cfg`, `ExcludedFactions.cfg`, `ExcludedLevels.cfg`, `ExcludedLayers.cfg`, `LayerRotation.cfg`, `LayerVoting.cfg`, `LayerVotingLowPlayers.cfg`, `LayerVotingNight.cfg`, `LevelRotation.cfg`, `License.cfg`, `MOTD.cfg`, `Rcon.cfg`, `RemoteAdminListHosts.cfg`, `RemoteBanListHosts.cfg`, `Server.cfg`, `ServerMessages.cfg`, `VoteConfig.cfg`.

---

## Image allowlist

Source: `apps/bridge/internal/validate/docker.go`.

| Constant | Value |
|---|---|
| `ServerImage` | `squad-server:latest` |
| `DepotInitImage` | `squad-panel/depot-init:latest` |

Any `container_run` request with an image not in this set is rejected with `forbidden`.

---

## Container name patterns

Source: `apps/bridge/internal/validate/docker.go`.

| Pattern | Used for |
|---|---|
| `^squad-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$` | Running Squad server containers |
| `^squad-depot-init-[0-9]{14}$` | Transient depot-init containers (timestamp suffix) |

---

## Constants

| Constant | Value |
|---|---|
| `PanelDataRoot` | `/var/lib/squad-panel` |
| `PanelConfigsRoot` | `/var/lib/squad-panel/configs` |
| `PanelSavedRoot` | `/var/lib/squad-panel/saved` |
| `DepotVolumeName` | `squad-depot` |
| `MaxFrame` | 16 MiB |
