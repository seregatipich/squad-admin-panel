#!/usr/bin/env bash
# uninstall.sh — safely tear down the panel host-side artifacts.
# Prompts for confirmation on every destructive step.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${REPO_DIR}/data"

log() { printf '\033[32m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[uninstall]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[uninstall]\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
  local msg="$1"
  read -r -p "$msg [y/N]: " ans
  [[ "$ans" =~ ^[yY]$ ]]
}

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run as root (sudo ./scripts/uninstall.sh)."
fi

if confirm "Stop + remove panel-host-bridge.service + .socket + binary + drop-in?"; then
  systemctl stop panel-host-bridge.service 2>/dev/null || true
  systemctl stop panel-host-bridge.socket 2>/dev/null || true
  systemctl disable panel-host-bridge.socket 2>/dev/null || true
  rm -f /etc/systemd/system/panel-host-bridge.service
  rm -f /etc/systemd/system/panel-host-bridge.socket
  rm -rf /etc/systemd/system/panel-host-bridge.service.d
  rm -f /etc/tmpfiles.d/panel-host-bridge.conf
  rm -rf /run/panel-host-bridge
  rm -f /run/panel-host-bridge.sock  # legacy single-file socket
  rm -f /usr/local/bin/panel-host-bridge
  systemctl daemon-reload
  log "removed bridge daemon, unit, drop-in, socket, tmpfiles"
fi

if confirm "Remove /var/lib/squad-panel symlink?"; then
  rm -f /var/lib/squad-panel
  log "removed /var/lib/squad-panel"
fi

if confirm "Remove /etc/squad-server and /var/log/panel-host-bridge (created by install-host-bridge.sh)?"; then
  rm -rf /etc/squad-server
  rm -rf /var/log/panel-host-bridge
  log "removed /etc/squad-server and /var/log/panel-host-bridge"
fi

# squad-depot is a bind-mount volume (device=${DATA_DIR}/depot,
# install-host-bridge.sh): removing the Docker volume record does not free
# the 12+ GB itself — those files live in the data tree and are only
# actually freed when it is removed below.
if confirm "Remove the squad-depot Docker volume record (bind-mounted to ${DATA_DIR}/depot; the game files themselves are only freed when the data tree below is removed)?"; then
  if docker volume rm squad-depot 2>/dev/null; then
    log "removed squad-depot volume"
  else
    warn "could not remove squad-depot volume (already gone, or still in use by a running container)"
  fi
fi

if confirm "Remove data tree ${DATA_DIR}? (WIPES DB, Redis, configs, saved logs, depot files)"; then
  rm -rf "${DATA_DIR}"
  log "removed ${DATA_DIR}"
fi

if confirm "Remove the 'panel' group?"; then
  if groupdel panel 2>/dev/null; then
    log "removed group 'panel'"
  else
    warn "could not remove group 'panel' (already gone, or still a user's primary group)"
  fi
fi

log "done."
