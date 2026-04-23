#!/usr/bin/env bash
# install-host-bridge.sh — idempotent installer for panel-host-bridge.
# Safe to re-run; detects existing state and skips steps already done.
# Must be run as root (uses sudo if the caller is not already root).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SRC="${REPO_DIR}/apps/bridge/bin/panel-host-bridge"
BIN_DST="/usr/local/bin/panel-host-bridge"
UNIT_DIR="/etc/systemd/system"

log()  { printf '\033[32m[install-host-bridge]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install-host-bridge]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[install-host-bridge]\033[0m %s\n' "$*" >&2; exit 1; }

# -------- 1. distro check --------------------------------------------------

if ! grep -qE 'Ubuntu (22\.04|24\.04)|Debian GNU/Linux 1[2-9]' /etc/os-release; then
  die "Unsupported distro. Supported: Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Debian 12+."
fi

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run this script as root (via sudo ./scripts/install-host-bridge.sh)."
fi

# -------- 2. ensure panel group + squad user -------------------------------

if ! getent group panel >/dev/null; then
  log "creating system group 'panel'"
  groupadd --system panel
fi

if ! id -u squad >/dev/null 2>&1; then
  log "creating system user 'squad'"
  useradd --system --create-home --home-dir /opt/squad-servers --shell /usr/sbin/nologin squad || true
else
  log "system user 'squad' already exists"
fi

mkdir -p /opt/squad-servers
chown squad:squad /opt/squad-servers

# -------- 3. build the Go binary if missing --------------------------------

if [[ ! -x "$BIN_SRC" ]]; then
  log "building Go bridge binary (CGO_ENABLED=0)"
  if ! command -v go >/dev/null; then
    die "Go toolchain not found. Install golang >= 1.22 or pre-build the binary."
  fi
  (cd "${REPO_DIR}/apps/bridge" && make build)
fi
[[ -x "$BIN_SRC" ]] || die "bridge binary missing at $BIN_SRC after build"

log "installing binary → $BIN_DST"
install -m 0755 "$BIN_SRC" "$BIN_DST"

# -------- 4. install systemd units -----------------------------------------

log "installing systemd units"
install -m 0644 "${REPO_DIR}/apps/bridge/deploy/panel-host-bridge.service" "$UNIT_DIR/"
install -m 0644 "${REPO_DIR}/apps/bridge/deploy/panel-host-bridge.socket"  "$UNIT_DIR/"

mkdir -p /etc/squad-server
chmod 0755 /etc/squad-server

systemctl daemon-reload

# -------- 5. enable + start the socket unit --------------------------------

if ! systemctl is-enabled --quiet panel-host-bridge.socket; then
  systemctl enable panel-host-bridge.socket
fi
systemctl start panel-host-bridge.socket
log "panel-host-bridge.socket active on /run/panel-host-bridge.sock"

# -------- 6. add invoking user (SUDO_USER) to the 'panel' group ------------

TARGET_USER="${SUDO_USER:-}"
if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx panel; then
    log "adding $TARGET_USER to 'panel' group (log out + back in for group to take effect)"
    usermod -aG panel "$TARGET_USER"
  fi
fi

log "done."
systemctl status panel-host-bridge.socket --no-pager --lines=0 || true
