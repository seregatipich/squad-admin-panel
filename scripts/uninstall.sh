#!/usr/bin/env bash
# uninstall.sh — safely remove panel-host-bridge and (optionally) Squad servers
# managed by the panel. Prompts for confirmation on every destructive step.

set -euo pipefail

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

if confirm "Stop and remove all squad-server-*.service units?"; then
  mapfile -t units < <(systemctl list-unit-files 'squad-server-*.service' --no-legend | awk '{print $1}')
  for u in "${units[@]}"; do
    [[ -z "$u" ]] && continue
    systemctl stop "$u" 2>/dev/null || true
    systemctl disable "$u" 2>/dev/null || true
    rm -f "/etc/systemd/system/$u"
    log "removed $u"
  done
  rm -f /etc/squad-server/instance-*.env
fi

if confirm "Remove /opt/squad-servers/* Squad install trees? (DATA LOSS)"; then
  rm -rf /opt/squad-servers/*
fi

if confirm "Stop + remove panel-host-bridge.service + .socket?"; then
  systemctl stop panel-host-bridge.service 2>/dev/null || true
  systemctl stop panel-host-bridge.socket 2>/dev/null || true
  systemctl disable panel-host-bridge.socket 2>/dev/null || true
  rm -f /etc/systemd/system/panel-host-bridge.service
  rm -f /etc/systemd/system/panel-host-bridge.socket
  rm -f /usr/local/bin/panel-host-bridge
fi

systemctl daemon-reload

if confirm "Remove the 'panel' group?"; then
  groupdel panel 2>/dev/null || true
fi

log "done."
