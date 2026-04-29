# `bridge` — changelog

## 2026-04-28 — Socket moved into stable runtime directory

### Changed

- **Socket path moved**: `/run/panel-host-bridge.sock` → `/run/panel-host-bridge/bridge.sock`. The directory is created at boot by a `tmpfiles.d` snippet (`apps/bridge/deploy/panel-host-bridge.tmpfiles.conf`, deployed to `/etc/tmpfiles.d/panel-host-bridge.conf` by `scripts/install-host-bridge.sh`) with mode `0750 root:panel`.
- **`apps/bridge/deploy/panel-host-bridge.socket`** `ListenStream` updated to the new path.
- **`apps/bridge/deploy/panel-host-bridge.service`** `ReadWritePaths` now includes `/run/panel-host-bridge` so the bridge process can mutate its own socket file (required for clean shutdown / rebind).
- **`apps/bridge/cmd/panel-host-bridge/main.go`** dev-mode fallback path updated.
- **`packages/shared-config/src/bridge-methods.ts`** `BRIDGE_SOCKET_DEFAULT` updated.
- **`apps/api/src/config.ts`**, **`apps/workers/{log-ingest,metrics-sampler,config-sync}/src/index.ts`**, **`scripts/{verify-bridge.sh,bootstrap.sh}`**, **`docker-compose.yml`** — all default-path references updated.
- **`docker-compose.yml`** volumes for the api/web/worker-log-ingest/worker-config-sync/worker-metrics-sampler services switched from single-file bind-mount (`/run/panel-host-bridge.sock:/run/panel-host-bridge.sock`) to **directory bind-mount** (`/run/panel-host-bridge:/run/panel-host-bridge`).

### Fixed

- **Stale-inode bug after every bridge restart.** Previously the api / worker containers bind-mounted the socket *file* directly. A bind-mount of a single file resolves to the file's inode at container-start; if the file is unlinked and recreated on the host (which `RemoveOnStop=yes` plus any `systemctl restart panel-host-bridge` would do), the container kept opening the original orphan inode and got `connect ECONNREFUSED` until manually recreated. With the directory mount the kernel re-resolves the file by name on every `connect(2)`, so consumers transparently pick up the fresh inode. Verified end-to-end on the live stack: `systemctl stop panel-host-bridge.socket` followed by `start` rotates the host inode `361247 → 362503`; api and worker containers see the same new inode without any docker recreate; subsequent `force_sync` flows return `state: 'in_sync'`.

### Migration notes

- Run `sudo bash scripts/install-host-bridge.sh`. The script:
  1. Drops `panel-host-bridge.tmpfiles.conf` into `/etc/tmpfiles.d/` and runs `systemd-tmpfiles --create` so `/run/panel-host-bridge/` is materialised before the .socket binds.
  2. Stops `panel-host-bridge.{socket,service}` if they are still bound to the legacy `/run/panel-host-bridge.sock` and removes that file.
  3. Reinstalls the unit files with the new `ListenStream`.
  4. Restarts the .socket unit on the new path.
- Then `docker compose up -d --force-recreate` to refresh the bind-mounts. Existing containers bound to the legacy `/run/panel-host-bridge.sock` will not see the new directory until recreated.
- `RuntimeDirectory=` was **not** used on the .service unit because socket activation runs the .socket BEFORE the .service, and `RuntimeDirectory=` only fires on .service start — the socket would have failed to bind on first boot. tmpfiles.d runs at sysinit-target time, before sockets.target, which is the correct ordering for our setup.

## 2026-04-26 — `directory_delete` RPC for server soft-delete orchestrator

### Added

- `directory_delete({ path }) → { removed: boolean }` — 18th whitelisted method. Calls `os.RemoveAll` against the **exact** `/var/lib/squad-panel/{configs,saved}/{uuid}` root. Idempotent; missing path returns `{ removed: false }` rather than erroring. Used by `apps/api/src/lib/server-delete.ts` after configs have been backed up to `config_versions`.
- `validate.PanelConfigsServerRoot(p)` and `validate.PanelSavedServerRoot(p)` in `apps/bridge/internal/validate/docker.go` — accept only the per-server root with a canonical UUID, no children, no trailing slash, no traversal. Used exclusively by `directory_delete`.
- Go unit tests in `apps/bridge/internal/handlers/handlers_test.go`: forbidden-path, file-path-under-configs forbidden, traversal forbidden, bad-UUID forbidden, idempotent missing-dir success, invalid JSON returns `invalid_args`. Validator-level tests for both root variants in `apps/bridge/internal/validate/docker_test.go`.
- E2E coverage in `apps/api/test/e2e/bridge-rpc.e2e.test.ts` (`describe('directory_delete (e2e)')`): success on `configs/{uuid}` root, success on `saved/{uuid}` root, idempotent re-delete, forbidden cases (traversal, file path, bad uuid, depot root).

### Changed

- `packages/shared-config/src/bridge-methods.ts` — appended `'directory_delete'` to `BRIDGE_METHODS`.
- `packages/bridge-client/src/client.ts` — new `directoryDelete(p) → call<{ removed: boolean }>('directory_delete', p, { timeoutMs: 60_000 })` wrapper plus `DirectoryDeleteParams`/`DirectoryDeleteResult` types.

### Migration notes

- No schema or systemd change. Redeploy the binary with `sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/` and `sudo systemctl restart panel-host-bridge.service`.
- Operators that have stale `/var/lib/squad-panel/{configs,saved}/{uuid}` directories from pre-soft-delete tombstones can NOT use `directory_delete` to clean them up retroactively unless the matching `servers` row exists; the API surface only invokes `directory_delete` from inside the soft-delete orchestrator. Manual `sudo rm -rf` remains the documented recovery path.

## 2025-11-15

### Removed

- `steamcmd_run`, `apt_install`, `systemctl_action`, `systemctl_daemon_reload`, `systemctl_write_unit`, `systemctl_read_unit`, `journalctl_follow`. The container migration replaced them with `container_*` and `depot_update`.

### Added

- `container_run`, `container_start`, `container_stop`, `container_rm`, `container_inspect`, `container_stats`, `container_logs_follow`.
- `depot_update` (transient `squad-panel/depot-init` container into the shared `squad-depot` volume).
- `host_agent_restart` (graceful self-restart while keeping the socket activated).

### Changed

- `MaxFrame` raised from 1 MiB to 16 MiB to accommodate `container_inspect` payloads.
- `file_*` allowlists now point under `/var/lib/squad-panel/{configs,saved}/{uuid}/` and `/var/lib/docker/volumes/squad-depot/` (RO).

### Migration notes

- Hosts upgraded from the systemd-era panel must re-run [`scripts/install-host-bridge.sh`](../../../scripts/install-host-bridge.sh) to get the new socket unit and create `/var/lib/squad-panel/{configs,saved}`.
- Existing `squad-server-{uuid}.service` units are no longer used. Operators should `systemctl disable --now squad-server-{uuid}` and migrate state by hand; the panel will not import legacy installs.
