# Bridge protocol

`panel-host-bridge` is a root-privileged Go daemon that accepts length-prefixed JSON-RPC calls on a unix domain socket. Docker containers mount that socket (bind-mount + peer credentials) and the `@squad/bridge-client` TypeScript package speaks to it on behalf of API and workers.

## Wire format

Every frame (request, response, stream chunk) is sent as:

```
4-byte big-endian uint32 length  |  UTF-8 JSON payload
```

`MaxFrame = 1 MiB`. Anything larger drops the connection. Streaming methods (`steamcmd_run`, `journalctl_follow`) interleave stream-chunk frames with the final response frame on the same socket:

```json
// request
{ "id": "req-uuid-v7", "method": "steamcmd_run", "params": { "args": [...] } }

// stream frame(s)
{ "id": "req-uuid-v7", "stream": "stdout", "data": "Update state (0x61) downloading, progress: 50.0%" }
{ "id": "req-uuid-v7", "stream": "stdout", "data": "Success! App '403240' fully installed." }

// final response
{ "id": "req-uuid-v7", "ok": true, "result": { "exit_code": 0 } }
```

## Authentication

For every new connection the bridge reads `SO_PEERCRED` (via `getsockopt`) to identify the calling UID and looks up the `panel` group. Non-members get a single error frame and the connection closed.

## Error codes

| Code            | Meaning                                                            |
|-----------------|--------------------------------------------------------------------|
| `forbidden`     | Argument violated the whitelist (path, unit, apt package, etc.)    |
| `invalid_args`  | Parameter validation failed (missing required field, wrong shape)  |
| `runtime_error` | External command exited non-zero, timed out, or OS error           |
| `timeout`       | Client-side timeout before reply arrived                           |
| `internal`      | Unexpected bridge bug — logged with full context                   |
| `transport`     | Client-only: socket closed mid-call                                |

## Methods

### `ping()` → `{ pong, version, hostname }`

Liveness probe. Always succeeds.

### `host_info()` → `HostInfo`

Static snapshot of the host:

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

### `host_metrics()` → `HostMetrics`

Live sample. Internally the bridge takes two short-interval samples so CPU% and net rates are non-zero on first call.

### `systemctl_action(unit, action)` → `{ output, status }`

`unit` must match either `^squad-server-[a-f0-9-]{36}\.service$` or `panel-host-bridge.service`.
`action` is one of `start | stop | restart | status | enable | disable`.

### `systemctl_daemon_reload()` → `{ status: 'done' }`

### `systemctl_write_unit(path, content)` → `{ status: 'written' }`

Writes atomically (`.new → rename`) with the previous content preserved as `.bak`. Path must live under `/etc/systemd/system/` and match the squad-server unit regex.

### `systemctl_read_unit(path)` → `{ content }`

Same path constraints as `systemctl_write_unit`.

### `steamcmd_run(args)` → streams stdout/stderr, returns `{ exit_code }`

The args list is whitelisted token-by-token. Required tokens and ordering:

1. `+@sSteamCmdForcePlatformType linux` (must precede `+login`)
2. `+force_install_dir /opt/squad-servers/<uuid>/` (regex-validated UUID)
3. `+login anonymous`
4. `+app_update 403240` (optional trailing `validate`)
5. `+quit` (recommended but not required)

### `apt_install(packages)` → `{ output, status }`

14-package whitelist (see `apps/bridge/internal/validate/apt.go`). Always runs with `DEBIAN_FRONTEND=noninteractive` and `DPkg::Lock::Timeout=120`.

### `file_read(path)` → `{ content }`

Reads up to 1 MiB from under `/opt/squad-servers/<uuid>/`, `/etc/systemd/system/`, or `/etc/squad-server/`. Rejects anything else.

### `file_write(path, content, mode?)` → `{ status: 'written' }`

Same roots as `file_read`. Non-atomic; use `file_atomic_write` for configs that Squad reads.

### `file_atomic_write(path, content, mode?)` → `{ status: 'written' }`

Writes sibling `.new` file, fsync, then `rename(2)` into place. If a file already existed, it is first renamed to `.bak`.

### `ufw_rule(action, proto, port, comment?)` → `{ output, status }`

Convenient add/remove wrapper for panel-managed firewall rules. Only ports ≥ 1024 are accepted; proto is `tcp`|`udp`.

### `process_info(pid)` → `ProcessInfoResult`

Reads `/proc/<pid>/{status,cmdline}`. Does not require the pid to belong to a panel-managed unit — the API layer ties process_info calls to the server owning that pid.

### `journalctl_follow(unit, since?, lines?)` → streams stdout, returns `{ exit_code }`

Same unit allow-list as `systemctl_action`. Emits log lines as they arrive; panel consumers tail them for event parsing.
