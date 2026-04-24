#!/usr/bin/env bash
# uninstall.sh — safely tear down the panel host-side artifacts.
# Prompts for confirmation on every destructive step.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${REPO_DIR}/data"

log() { printf '\033[32m[uninstall]\033[0m %s\n' "$*"; }
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
  rm -f /usr/local/bin/panel-host-bridge
  systemctl daemon-reload
  log "removed bridge daemon, unit, drop-in, socket"
fi

if confirm "Remove /var/lib/squad-panel symlink?"; then
  rm -f /var/lib/squad-panel
  log "removed /var/lib/squad-panel"
fi

if confirm "Remove squad-depot Docker volume (12+ GB of Squad game files)?"; then
  docker volume rm squad-depot 2>/dev/null || true
  log "removed squad-depot volume"
fi

if confirm "Remove data tree ${DATA_DIR}? (WIPES DB, Redis, configs, saved logs)"; then
  rm -rf "${DATA_DIR}"
  log "removed ${DATA_DIR}"
fi

if confirm "Remove the 'panel' group?"; then
  groupdel panel 2>/dev/null || true
fi

log "done."
