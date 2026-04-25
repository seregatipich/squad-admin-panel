# `bridge` — changelog

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
