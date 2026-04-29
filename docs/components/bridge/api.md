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

Streaming methods: `container_logs_follow`, `depot_update`. They interleave `stream:'stdout'` / `stream:'stderr'` chunks with the final response on the same connection.

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

All 18 RPC methods from `BRIDGE_METHODS`. Request shapes match the Go handlers; the TS client mirrors them in [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts).

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

### Self

#### `host_agent_restart()` → `{ status: 'restarting' }`

Asks systemd to restart `panel-host-bridge.service`. Used by the panel's "rotate bridge" admin action; the socket stays activated so callers reconnect transparently.

## Adding a new method

If you add a method, three sources must change in the same commit:

1. Append to `BRIDGE_METHODS` in [`packages/shared-config/src/bridge-methods.ts`](../../../packages/shared-config/src/bridge-methods.ts).
2. Add the typed wrapper in [`packages/bridge-client/src/client.ts`](../../../packages/bridge-client/src/client.ts).
3. Implement the handler + validator in [`apps/bridge/internal/handlers/handlers.go`](../../../apps/bridge/internal/handlers/handlers.go) and the matching `validate.*` package.

Add a case to [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) covering both the success and the forbidden paths.
