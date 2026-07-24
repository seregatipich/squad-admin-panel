# `bridge` — RPC API

The bridge speaks length-prefixed JSON-RPC over `/run/panel-host-bridge/bridge.sock`. Method names are pinned by [`packages/shared-config/src/bridge-methods.ts`](../../../packages/shared-config/src/bridge-methods.ts) — keep that file, [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts), and [`apps/bridge/internal/handlers/handlers.go`](../../../apps/bridge/internal/handlers/handlers.go) in sync in the same commit.

## Wire format

Every frame (request, response, stream chunk) is:

```
4-byte big-endian uint32 length  |  UTF-8 JSON payload
```

`MaxFrame = 16 MiB` (`BRIDGE_MAX_FRAME_BYTES`). Anything larger drops the connection.

```json
// request
{ "id": "req-uuid-v7", "method": "container_run", "params": { /* see below */ } }

// stream frame(s) — for streaming methods only
{ "id": "req-uuid-v7", "stream": "stdout", "data": "Update state (0x61) downloading, progress: 50.0%" }

// final response
{ "id": "req-uuid-v7", "ok": true, "result": { "exit_code": 0 } }
// or
{ "id": "req-uuid-v7", "ok": false, "code": "forbidden", "message": "image not in allowlist" }
```

Streaming methods: `container_logs_follow`, `depot_update`, `docker_prune`. They interleave `stream:'stdout'` / `stream:'stderr'` chunks with the final response on the same connection.

## Authentication

For every new connection the bridge reads `SO_PEERCRED` and looks up the caller's primary group. Non-`panel` callers get an error frame and the connection is closed.

## Error codes

| Code | Meaning |
|---|---|
| `forbidden` | Argument violated the allowlist (path, image, container name, etc.). |
| `invalid_args` | Parameter validation failed (missing required field, wrong shape). |
| `runtime_error` | External command exited non-zero, timed out, or OS error. |
| `timeout` | Client-side timeout before reply arrived. |
| `internal` | Unexpected bridge bug — logged with full context. |
| `transport` | Client-only: socket closed mid-call. |

## Methods

All 25 RPC methods from `BRIDGE_METHODS`. Request shapes match the Go handlers; the TS client mirrors them in [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts).

### Liveness / host

#### `ping()` → `{ pong, version, hostname }`

Liveness probe. Always succeeds.

#### `host_info()` → `HostInfo`

Static host snapshot.

```ts
{
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  ram_total_bytes: number;
}
```

#### `host_metrics()` → `HostMetrics`

Live sample. Internally takes two short-interval samples so CPU% and net rates are non-zero on first call.

#### `process_info({ pid })` → `ProcessInfoResult`

Reads `/proc/<pid>/{status,cmdline}`. The bridge does not require the pid to belong to a panel-managed container; the API layer ties `process_info` calls to the server owning that pid.

### Files

All file methods are restricted to:

- `/var/lib/squad-panel/configs/{uuid}/ServerConfig/<allowed-cfg-name>` (RW)
- `/var/lib/squad-panel/saved/{uuid}/**` (RW)
- `/var/lib/docker/volumes/squad-depot/**` (RO)
- `/var/lib/squad-panel/.first-owner-claimed` (read + atomic_write, exact-match only — sentinel for the first-owner claim trick; see [`docs/architecture/decisions.md`](../../architecture/decisions.md#2026-04-25--steam-only-login--steam_id64-pk--dual-anchor-first-owner-trick))

Allowed cfg filenames are pinned by `ALLOWED_CONFIG_FILES` in `shared-config` (19 files: `Admins.cfg`, `Bans.cfg`, …, `VoteConfig.cfg`).

#### `file_read({ path })` → `{ content }`

Up to 16 MiB. Anything outside the allowlist returns `forbidden`.

#### `file_read_tail({ path, max_bytes? })` → `{ content, offset, size, truncated }`

Reads up to `max_bytes` from the **end** of `path`. When `offset > 0` the read starts at the next `\n` after the truncation point so the caller never sees a partial first line. Used by the diagnostic-bundle builder to capture the tail of `SquadGame.log` without slurping multi-MB files.

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Required. Same allowlist as `file_read` (configs / saved / depot RO / sentinel). |
| `max_bytes` | `number` | Optional. Clamp semantics: `<= 0` (or unset) defaults to `65536` (64 KiB); values in `(0, 1048576]` (1 MiB) are honored as-is; values `> 1048576` are clamped down to the 1 MiB ceiling. |

| Result field | Type | Description |
|---|---|---|
| `content` | `string` | Tail bytes after the newline-snap. Empty when the file is empty or the tail window contained no newline. |
| `offset` | `number` | Byte offset where `content` begins in the source file (0 when the whole file fits, otherwise the position of the byte immediately after the snap newline). |
| `size` | `number` | Total size of the file in bytes at read time. |
| `truncated` | `boolean` | `true` iff `size > max_bytes` (i.e. some prefix of the file was skipped). |

Errors: `forbidden` (path outside allowlist), `invalid_args` (params not JSON), `runtime_error` (open / stat / seek failed).

```json
// request
{ "id": "req-1", "method": "file_read_tail", "params": {
  "path": "/var/lib/squad-panel/saved/<uuid>/SquadGame/Saved/Logs/SquadGame.log",
  "max_bytes": 65536
} }

// response (file is 12 MiB)
{ "id": "req-1", "ok": true, "result": {
  "content": "[2026.04.28-10.00.00:000][000]LogNet: ...\n...",
  "offset": 12516352,
  "size": 12582912,
  "truncated": true
} }
```

#### `file_write({ path, content, mode? })` → `{ status: 'written' }`

Non-atomic. Use only when atomicity is not required.

#### `file_atomic_write({ path, content, mode? })` → `{ status: 'written' }`

Writes a sibling `.new`, fsyncs, then `rename(2)` into place. Existing file is renamed to `.bak` first. `MkdirAll`s up through the allowed root.

#### `directory_delete({ path })` → `{ removed: boolean }`

`os.RemoveAll(path)` against the **exact** per-server data root. Used by the soft-delete orchestrator after backing up configs into `config_versions`.

Path allowlist (validated by `validate.PanelConfigsServerRoot` / `validate.PanelSavedServerRoot` in [`apps/bridge/internal/validate/docker.go`](../../../apps/bridge/internal/validate/docker.go)): the path must be **exactly** one of:

- `/var/lib/squad-panel/configs/{uuid}` — the per-server config root.
- `/var/lib/squad-panel/saved/{uuid}` — the per-server saved-state root.

Where `{uuid}` matches the canonical UUID v4/v7 regex. No trailing slash, no traversal, no children of the root, no other prefix. Anything else (including a `ServerConfig` subpath, the depot root, or `/etc/passwd`) returns `forbidden`.

**Idempotent**: a missing directory returns `{ removed: false }` (not an error). A real removal returns `{ removed: true }`. Any non-`ENOENT` failure surfaces as `runtime_error`.

```json
// success
{ "id": "req-1", "ok": true, "result": { "removed": true } }
// idempotent miss
{ "id": "req-2", "ok": true, "result": { "removed": false } }
// allowlist miss (sub-path, traversal, bad uuid, unknown root, file path)
{ "id": "req-3", "ok": false, "code": "forbidden", "message": "..." }
```

### Network

#### `ufw_rule({ action, proto, port, comment? })` → `{ output, status }`

Adds/removes a panel-managed firewall rule. Only ports ≥ 1024 are accepted; `proto` is `tcp` | `udp`.

### Containers

The bridge composes `docker run` from structured params. Allowed images: `squad-server:latest` and `squad-panel/depot-init:latest`. Container names must match `SERVER_CONTAINER_REGEX` (`squad-<uuid>`).

#### `container_run({ image, name, env, mounts, host_network, user, read_only, ports? })` → `{ container_id }`

The bridge composes (for a Squad server):

```
docker run -d --network host --user 1001:1001 --read-only \
  -v squad-depot:/squad:ro \
  -v /var/lib/squad-panel/configs/{uuid}/ServerConfig:/squad/SquadGame/ServerConfig:rw \
  -v /var/lib/squad-panel/saved/{uuid}:/squad/SquadGame/Saved:rw \
  squad-server:latest
```

`forbidden` on:

- image outside allowlist
- name not matching `SERVER_CONTAINER_REGEX`
- mount source outside the allowed roots

#### `container_start({ name })` → `{ status: 'started' }`

#### `container_stop({ name, timeout? })` → `{ status: 'stopped' }`

Sends SIGTERM, waits up to `timeout` seconds, then SIGKILL.

#### `container_rm({ name, force? })` → `{ status: 'removed' }`

#### `container_inspect({ name })` → `ContainerInspectResult`

Wraps `docker inspect <name>`. Returns `{ exists: false }` when the container is gone (not an error).

#### `container_stats({ name })` → `{ cpu_pct, mem_bytes, net_rx_bytes, net_tx_bytes }`

One-shot sample. The status-reconciler uses this every 4 s.

#### `container_logs_follow({ name, since?, lines? })` → streams stdout/stderr, returns `{ exit_code }`

Long-lived — clients should use a per-WebSocket bridge connection (`app.makeBridgeClient()`), not the shared `app.bridge`.

### Depot

#### `depot_update({ validate? })` → streams stdout/stderr, returns `{ exit_code }`

Spawns a transient `squad-panel/depot-init` container that runs `steamcmd +app_update 403240 [validate] +quit` against the shared `squad-depot` volume. `steamcmd` arg composition happens **inside the bridge** — callers don't pass tokens. Initial run takes ~25 minutes.

### Operational visibility

#### `panel_disk_usage({ force? })` → `PanelDiskUsageResult`

Reports panel-owned on-disk footprint by combining `du -sb` walks of `/var/lib/squad-panel/{configs,saved,audit-archive}`, `docker system df --format '{{json .}}' -v` filtered to panel-owned images and volumes, and `statfs(/var/lib/squad-panel)` for whole-host capacity. Result is computed at most once every 5 minutes and cached in-process; subsequent calls within the TTL return the same payload with `cache_age_seconds` advanced.

Optional params:

| Field | Type | Default | Description |
|---|---|---|---|
| `force` | bool | `false` | When `true`, skip the cache read and recompute (`du` + `docker df` + `statfs`). The fresh result is still written into the cache so subsequent non-force calls within the TTL benefit immediately. The API exposes this as `?refresh=1` on `GET /api/v1/host/disk-usage`. |

The wire input has no caller-controlled paths, so there is no path allowlist. The method's allowlist is internal:

- Filesystem walks: `<panel_root>/configs`, `<panel_root>/saved` (plus per-server subdirs by listing immediate children), `<panel_root>/audit-archive`. Missing directories are reported as zero, never as an error. `panel_root` defaults to `/var/lib/squad-panel`.
- Docker volumes counted: `squad-depot`, `squad-panel_pg-data`, `squad-panel_redis-data`. All other volumes are dropped.
- Docker images counted (any tag): `squad-server`, `squad-panel/depot-init`, `squad-panel/api`, `squad-panel/web`, `squad-panel/worker`. All other images are dropped.

Response shape:

| Field | Type | Description |
|---|---|---|
| `configs_bytes` | int64 | `du -sb /var/lib/squad-panel/configs` |
| `saved_total_bytes` | int64 | `du -sb /var/lib/squad-panel/saved` |
| `saved_per_server` | array of `{ uuid, bytes }` | Per-server `du` of each immediate subdir of `saved/`. Empty array when `saved/` is missing or has no children. |
| `depot_volume_bytes` | int64 | Bytes attributed to the `squad-depot` Docker named volume. Already included in `docker_volumes`; surfaced separately for convenience. **Not added to `total_panel_bytes` to avoid double-counting.** |
| `docker_volumes` | array of `{ name, bytes }` | Panel-owned Docker volume sizes. Always a non-null JSON array. |
| `docker_images` | array of `{ repository, tag, bytes }` | Panel-owned Docker image sizes. Always a non-null JSON array. |
| `audit_archive_bytes` | int64 | `du -sb /var/lib/squad-panel/audit-archive`, 0 when missing. |
| `total_panel_bytes` | int64 | `configs_bytes + saved_total_bytes + audit_archive_bytes + sum(docker_volumes.bytes) + sum(docker_images.bytes)`. Depot volume is **not** added separately. |
| `host_total_bytes` | int64 | `statfs.Blocks * statfs.Bsize` for `panel_root` (or its parent if `panel_root` is missing). |
| `host_used_bytes` | int64 | `(statfs.Blocks - statfs.Bavail) * statfs.Bsize` for the same target. |
| `computed_at` | string | RFC 3339 UTC timestamp of the underlying compute. Stable across cache hits within the 5-minute TTL. |
| `cache_age_seconds` | int | `0` on a fresh compute; `floor(seconds since computed_at)` on a cache hit. |

Errors: returns `runtime_error` with a descriptive message when `du`, `statfs`, or `docker system df` fail. There is no `forbidden` path because no caller input feeds into a path or shell argument.

#### `squad_log_retention_sweep({ archive_server_ids })` → `SquadLogRetentionSweepResult`

Deletes expired rotated Squad log files from the host saved tree. The only accepted param is `archive_server_ids: string[]` (LOG-3, #51) — the set of server UUIDs whose expiring logs must be archived before deletion. Callers still cannot pass a path, glob, or retention duration, and the bridge owns every filesystem path: it scans only `/var/lib/squad-panel/saved/{uuid}/SquadGame/Saved/Logs/` and stages archives only under `$PANEL_BACKUP_DUMP_ROOT` (`${DATA_DIR}/backup-dump`). Unknown keys (e.g. a caller-supplied `path`) are rejected as `invalid_args`.

Deletion policy:

- delete only regular files whose basename matches `SquadGame*.log`;
- never delete exact `SquadGame.log`, even if its `mtime` is older than 10 days;
- delete only when `mtime + 10d < now`;
- skip non-UUID saved subdirectories and missing log directories;
- for a server in `archive_server_ids`, copy the expiring file into `$PANEL_BACKUP_DUMP_ROOT/log-archive/{uuid}/{name}` **before** deleting it (the restic `backup` sidecar snapshots this path via `RESTIC_BACKUP_SOURCES=/data`). A copy failure is recorded as an error and the file is **not** deleted — never removed unarchived;
- continue on per-file/per-server errors and return a bounded error summary.

Response shape:

| Field | Type | Description |
|---|---|---|
| `retention_days` | int | Fixed at `10`. Not configurable in this slice. |
| `cutoff` | string | RFC 3339 UTC cutoff timestamp (`now - 10d`). |
| `servers_scanned` | int | Count of valid UUID saved directories inspected. |
| `log_dirs_scanned` | int | Count of existing `SquadGame/Saved/Logs` directories read successfully. |
| `files_scanned` | int | Count of regular files found in scanned log dirs. |
| `deleted_count` | int | Count of files removed. |
| `deleted_bytes` | int64 | Sum of removed file sizes before deletion. |
| `archived_count` | int | Count of files copied into the backup staging tree before deletion. |
| `archived_bytes` | int64 | Sum of archived file sizes. |
| `error_count` | int | Total errors encountered while continuing the sweep. |
| `errors` | array | First 20 error summaries: `{ server_id?, file?, error }`. |

Errors: `invalid_args` if an unknown param key is supplied or an `archive_server_ids` entry is not a valid server UUID. OS-level per-file failures (including archive-copy failures) are captured in the response instead of failing the whole RPC.

### Self

#### `host_agent_restart()` → `{ status: 'restarting' }`

Asks systemd to restart `panel-host-bridge.service`. Used by the panel's "rotate bridge" admin action; the socket stays activated so callers reconnect transparently.

## Diagnostic events (journald)

The bridge does NOT connect to Redis directly — pulling Redis credentials into the privileged daemon would widen the attack surface. Instead the bridge writes structured JSON lines to **stderr**, which systemd captures into the journal. `worker-diag-flush` runs `journalctl -u panel-host-bridge -o json -f` as a subprocess, parses each line, and `XADD`s entries with `DIAG_EVENT == '1'` into `diag:queue` under the same shape as native producers.

Every emit is a single line of JSON on `os.Stderr`:

```json
{
  "DIAG_EVENT": "1",
  "ts": "2026-04-29T10:00:00Z",
  "component": "bridge",
  "kind": "bridge.client.connected",
  "severity": "info",
  "message": "panel peer connected",
  "uid": 1000,
  "pid": 4242,
  "user": "squad"
}
```

The `DIAG_EVENT` field is the marker the forwarder filters on — any other stderr line (slog logs, journald metadata) is ignored. Payload keys are merged flat into the top-level record; the forwarder splits them back out into the `payload` JSON field on the Redis Stream.

Helper: [`handlers.DiagLog(component, kind, severity, message, payload)`](../../../apps/bridge/internal/handlers/handlers.go) in `apps/bridge/internal/handlers/handlers.go`. Its writer is `handlers.DiagSink` (defaults to `os.Stderr`; tests swap it for a buffer).

### Emitted kinds

| Kind | Severity | When | Payload |
|---|---|---|---|
| `bridge.client.connected` | `info` | After `auth.ResolvePeer` succeeds in `cmd/panel-host-bridge/main.go::serveConn`. | `{ uid, pid, user }` |
| `bridge.client.disconnected` | `info` (peer EOF) / `warn` (untrusted-peer reject) | `defer` inside `serveConn`. | `{ reason: 'eof' \| 'shutdown' \| 'read_frame_error' \| 'untrusted_peer', uid, pid, user, err? }` |
| `bridge.panic` | `fatal` | Inside the `defer recover()` block of `Dispatcher.Handle`. The handler still returns `rpc.NewErrorResponse(req.ID, internal, ...)` so the client sees a normal error frame. | `{ method, request_id, recovered }` |
| `bridge.signal.sigterm` | `info` | First line of the SIGTERM/SIGINT handler in `main.go`, before the listener is closed. | `{ signal, version }` |
| `bridge.host_agent_restart` | `info` | First line of the `host_agent_restart` handler, before the delayed `systemctl restart` goroutine is scheduled. | `{ request_id }` |

These are complementary to the API-side `bridge.client.connected` / `bridge.client.disconnected` / `bridge.rpc.error` emits produced by `apps/api/src/plugins/bridge.ts` from the TS bridge-client perspective. The Go-side emits cover the case where the API is offline or the bridge restarts independently.

### Forwarder requirements

`worker-diag-flush` runs the forwarder; see [`docs/components/workers/worker-diag-flush/configuration.md`](../workers/worker-diag-flush/configuration.md) for the journald bind-mounts and the `DIAG_JOURNALD_*` knobs.

## Adding a new method

If you add a method, three sources must change in the same commit:

1. Append to `BRIDGE_METHODS` in [`packages/shared-config/src/bridge-methods.ts`](../../../packages/shared-config/src/bridge-methods.ts).
2. Add the typed wrapper in [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts).
3. Implement the handler + validator in [`apps/bridge/internal/handlers/handlers.go`](../../../apps/bridge/internal/handlers/handlers.go) and the matching `validate.*` package.

Add a case to [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) covering both the success and the forbidden paths.
