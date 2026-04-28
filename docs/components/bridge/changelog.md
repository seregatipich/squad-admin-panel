# `bridge` — changelog

## 2026-04-28 — `panel_disk_usage` E2E coverage

### Added

- Two cases in [`apps/api/test/e2e/bridge-rpc.e2e.test.ts`](../../../apps/api/test/e2e/bridge-rpc.e2e.test.ts) inside `describe('bridge RPC surface (e2e)')`:
  - `panel_disk_usage returns a sane shape against the live host` — asserts `host_total_bytes > 0`, `total_panel_bytes >= 0`, `host_used_bytes >= total_panel_bytes - 1024`, array-typed `saved_per_server`/`docker_volumes`/`docker_images`, parseable ISO `computed_at`, and `cache_age_seconds ∈ [0, 360)`.
  - `panel_disk_usage caches results — two calls share computed_at and advance cache_age_seconds` — second call after a 1.1 s sleep returns the same `computed_at` with a strictly larger `cache_age_seconds`, proving the in-bridge 5-minute cache.

### Notes

- The handler takes no params and ignores client-supplied keys, so there is no meaningful "forbidden" case for this RPC. Forbidden-path coverage applies only to methods that accept paths or container names.
- The new cases are excluded from `pnpm turbo run test` by `vitest.e2e.config.ts`. They run on the deployment host (or staging replica) via `pnpm --filter @squad/api test:e2e`.

## 2026-04-28 — `panel_disk_usage` RPC for operational visibility

### Added

- `panel_disk_usage({}) → PanelDiskUsageResult` — 19th whitelisted method. Combines `du -sb` walks of `/var/lib/squad-panel/{configs,saved,audit-archive}`, `docker system df --format '{{json .}}' -v` filtered to panel-owned volumes (`squad-depot`, `squad-panel_pg-data`, `squad-panel_redis-data`) and images (`squad-server`, `squad-panel/depot-init`, `squad-panel/api`, `squad-panel/web`, `squad-panel/worker`), and `syscall.Statfs(/var/lib/squad-panel)` for whole-host capacity. Result is cached in-process for 5 minutes; subsequent calls return the same payload with `cache_age_seconds` advanced.
- `panelDiskUsageResult`, `savedEntry`, `dockerVol`, `dockerImg` Go types + a `parseHumanSize` helper for `docker system df` size strings (`1.2GB`, `512MB`, `0B`).
- `Dispatcher` injectors (`panelRoot`, `duFn`, `statfsFn`, `dockerDfFn`) so the handler is fully unit-testable without root or a live Docker daemon.
- Three Go unit tests in `apps/bridge/internal/handlers/handlers_test.go`: full-result computation against a tempdir, cache hit within TTL (no probe re-invocation, identical `computed_at`), missing-dir tempdir returns zero counters with empty `saved_per_server`.

### Changed

- `Dispatcher.Handle` switch gains a `panel_disk_usage` case routed to the new method.

### Migration notes

- No schema or systemd change. Redeploy the binary with `sudo install -m 0755 apps/bridge/bin/panel-host-bridge /usr/local/bin/` and `sudo systemctl restart panel-host-bridge.service`. The 5-minute cache is per-process, so the first call after restart triggers a full compute.
- The wire request payload is the empty object `{}`; older clients that send no `params` field should add `params: {}` for forward compatibility.

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
