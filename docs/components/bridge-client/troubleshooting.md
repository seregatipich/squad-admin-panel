# `bridge-client` — troubleshooting

## Every call after a stream fails returns `BridgeError('transport', 'client is closed')`

**Symptom**: After a `containerLogsFollow` or `depotUpdate` call encounters an error, all subsequent calls on the same client instance fail with the "client is closed" error.

**Cause**: An older version of `attachHandlers` set `this.closed = true` on a decode error. Once `closed` is `true`, `callImpl` rejects immediately without attempting to reconnect.

**Fix**: The current code in `packages/bridge-client/src/client.ts` (lines 209–225) deliberately does **not** set `closed = true` in the decode-error path. It only destroys the socket and clears `this.socket`. The next call will reconnect. If you see this bug resurface, check that the decode-error handler in `attachHandlers` matches the current pattern.

## `EACCES` or `ENOENT` on connect

**Symptom**: `BridgeError('transport', 'connect EACCES /run/panel-host-bridge/bridge.sock')` or `ENOENT`.

**Cause** (EACCES): The Node process's user is not in the `panel` group. The socket is `0660 root:panel`.

**Diagnostic**:
```bash
id                                         # check current user groups
ls -la /run/panel-host-bridge/bridge.sock         # verify permissions and existence
```

**Fix**:
```bash
sudo usermod -aG panel $USER               # add your user to panel group; re-login required
sg panel -c 'node myScript.js'             # or use sg to run in-group without re-login
```

**Cause** (ENOENT): The bridge daemon is not running.

```bash
sudo systemctl status panel-host-bridge
sudo systemctl start panel-host-bridge
```

## `BridgeError('forbidden')` on file operations

**Symptom**: `fileRead` or `fileAtomicWrite` returns `BridgeError('forbidden', ...)`.

**Cause**: The `path` parameter resolves outside the allowlisted directories:
- `/var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg`
- `/var/lib/squad-panel/saved/{uuid}/`
- `/var/lib/docker/volumes/squad-depot/` (read-only)

**Fix**: Ensure the path is constructed from `PANEL_CONFIGS_ROOT` + `/{uuid}/ServerConfig/` + `filename`. Never pass user-controlled strings directly.

## `BridgeError('forbidden')` on `containerRun`

**Symptom**: `containerRun` fails with `forbidden`.

**Cause**: The `image` parameter is not `squad-server:latest` or `squad-panel/depot-init:latest`.

**Fix**: Only pass one of the two allowlisted image names. Tags other than `latest` are not permitted.

## `BridgeError('timeout', 'bridge call container_stop timed out after 120000ms')`

**Symptom**: Graceful stop hangs and times out.

**Cause**: The Squad process is not responding to SIGTERM. The bridge sends `docker stop --time=<timeout_sec>` which sends SIGTERM then waits before SIGKILL.

**Diagnostic**:
```bash
docker logs squad-<uuid> --tail 50    # check for shutdown log lines
docker inspect squad-<uuid>           # verify the container state
```

**Fix**: Use `containerStop` with a short `timeout_sec` (e.g. 5) to trigger a faster SIGKILL, or call `containerRm` with `force: true` if the container is unresponsive.

## Frame decode error log, subsequent calls reconnect

**Symptom**: `bridge frame decode error; dropping socket` appears in logs, followed by a reconnect on the next call.

**Cause**: A Go-side bug or a mid-stream socket disruption caused the bridge to send a malformed frame. This is handled safely — the client drops the socket, rejects in-flight calls, and reconnects.

**Action**: If this happens repeatedly, check the bridge daemon logs:
```bash
sudo journalctl -u panel-host-bridge --since 5min
```

## Useful diagnostic commands

```bash
sudo systemctl status panel-host-bridge
sudo journalctl -u panel-host-bridge -n 100
sg panel -c 'bash scripts/verify-bridge.sh'   # RPC smoke test (all 17 methods)
ls -la /run/panel-host-bridge/bridge.sock
docker ps --filter name=squad-               # verify Squad containers
```
