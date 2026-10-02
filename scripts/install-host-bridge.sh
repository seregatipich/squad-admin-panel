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

set_env_key() {
  local key="$1"
  local value="$2"
  local file="${REPO_DIR}/.env"
  local escaped

  [[ -f "$file" ]] || return 0
  escaped=$(printf '%s' "$value" | sed 's/[&|]/\\&/g')
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

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
PANEL_GID=$(getent group panel | cut -d: -f3)

if ! id -u squad >/dev/null 2>&1; then
  log "creating system user 'squad'"
  useradd --system --create-home --home-dir /opt/squad-servers --shell /usr/sbin/nologin squad || true
else
  log "system user 'squad' already exists"
fi

mkdir -p /opt/squad-servers
chown squad:squad /opt/squad-servers

# -------- 3. (re)build the Go binary if it's missing or stale --------------

# The old `if [[ ! -x "$BIN_SRC" ]]` guard skipped the build entirely once a
# binary existed at all, so a re-run after `git pull` silently reinstalled a
# stale binary — the RPC allowlist must move in lockstep across
# bridge-methods.ts / client.ts / handlers.go, so an old binary against a new
# API gives "forbidden"/"unknown method" errors. Rebuild whenever any bridge
# source file is newer than the built binary, not only when it's absent.
NEEDS_BUILD=0
if [[ ! -x "$BIN_SRC" ]]; then
  NEEDS_BUILD=1
elif find "${REPO_DIR}/apps/bridge" -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) \
  -newer "$BIN_SRC" -print -quit 2>/dev/null | grep -q .; then
  NEEDS_BUILD=1
fi

if [[ "$NEEDS_BUILD" -eq 1 ]]; then
  log "building Go bridge binary (CGO_ENABLED=0)"
  if ! command -v go >/dev/null; then
    die "Go toolchain not found. Install golang >= 1.22 or pre-build the binary."
  fi
  (cd "${REPO_DIR}/apps/bridge" && make build)
  # Under sudo the build output is root-owned; the stand deploy's `rsync
  # --delete` runs as the repo owner and fails on a file it cannot unlink.
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    chown -R "${SUDO_USER}:${SUDO_USER}" "${REPO_DIR}/apps/bridge/bin"
  fi
fi
[[ -x "$BIN_SRC" ]] || die "bridge binary missing at $BIN_SRC after build"

BIN_CHANGED=0
if ! cmp -s "$BIN_SRC" "$BIN_DST" 2>/dev/null; then
  BIN_CHANGED=1
fi

log "installing binary → $BIN_DST"
install -m 0755 "$BIN_SRC" "$BIN_DST"

# -------- 4. install systemd units -----------------------------------------

# Hash of the installed unit files; files that do not exist yet (first
# install) contribute nothing, so the fingerprint changes once they appear.
unit_fingerprint() {
  { cat "$UNIT_DIR"/panel-host-bridge.service "$UNIT_DIR"/panel-host-bridge.socket \
    "$UNIT_DIR"/panel-host-bridge.service.d/*.conf 2>/dev/null || true; } | sha256sum
}
UNITS_BEFORE=$(unit_fingerprint)

log "installing systemd units"
install -m 0644 "${REPO_DIR}/apps/bridge/deploy/panel-host-bridge.service" "$UNIT_DIR/"
install -m 0644 "${REPO_DIR}/apps/bridge/deploy/panel-host-bridge.socket"  "$UNIT_DIR/"

# tmpfiles snippet — creates the /run/panel-host-bridge runtime directory at
# boot (root:panel 0750) so that Docker bind-mounts of the directory pick up
# the live socket inode on every restart. Bind-mounting the socket file
# directly froze consumers on the original inode.
install -m 0644 "${REPO_DIR}/apps/bridge/deploy/panel-host-bridge.tmpfiles.conf" \
  /etc/tmpfiles.d/panel-host-bridge.conf
systemd-tmpfiles --create /etc/tmpfiles.d/panel-host-bridge.conf

# Migrate any stale legacy socket file from the old single-file layout — its
# presence at /run/panel-host-bridge.sock would either confuse operators or
# cause socket-activation conflicts if the .socket unit is still pointing
# at it after a botched upgrade.
if [[ -S /run/panel-host-bridge.sock ]]; then
  log "removing legacy socket /run/panel-host-bridge.sock (replaced by /run/panel-host-bridge/bridge.sock)"
  systemctl stop panel-host-bridge.socket panel-host-bridge.service 2>/dev/null || true
  rm -f /run/panel-host-bridge.sock
fi

mkdir -p /etc/squad-server
chmod 0755 /etc/squad-server

mkdir -p /var/log/panel-host-bridge
chmod 0750 /var/log/panel-host-bridge

# ReadWritePaths requires every listed path to exist, even if the feature
# using it isn't actually installed on this host yet.
mkdir -p /etc/ufw

# -------- 4a. data tree (self-contained under REPO_DIR/data) ---------------

DATA_DIR="${REPO_DIR}/data"
log "provisioning data tree at ${DATA_DIR}"
mkdir -p \
  "${DATA_DIR}/postgres" \
  "${DATA_DIR}/redis" \
  "${DATA_DIR}/caddy-data" \
  "${DATA_DIR}/caddy-config" \
  "${DATA_DIR}/backup-repo" \
  "${DATA_DIR}/backup-dump" \
  "${DATA_DIR}/depot" \
  "${DATA_DIR}/media" \
  "${DATA_DIR}/servers/configs" \
  "${DATA_DIR}/servers/saved"

chmod 0755 "${DATA_DIR}"
chmod 0700 "${DATA_DIR}/postgres"
# Uploaded media (media_data bind mount); api and worker-media-publisher run
# as root, so nobody else needs to read it.
chmod 0750 "${DATA_DIR}/media"
chmod 0755 "${DATA_DIR}/servers"
chmod 0750 "${DATA_DIR}/servers/configs" "${DATA_DIR}/servers/saved"
chown "${SUDO_USER:-root}:${SUDO_USER:-root}" "${DATA_DIR}" 2>/dev/null || true

# Bridge Go code allowlists paths under /var/lib/squad-panel; keep that as a
# symlink to the physical tree so the security allowlist keeps working without
# a Go rebuild when the data root lives elsewhere.
if [[ -L /var/lib/squad-panel ]]; then
  CURRENT=$(readlink /var/lib/squad-panel)
  if [[ "$CURRENT" != "${DATA_DIR}/servers" ]]; then
    rm -f /var/lib/squad-panel
  fi
elif [[ -e /var/lib/squad-panel ]]; then
  die "/var/lib/squad-panel exists and is not a symlink. Move it aside before re-running."
fi
if [[ ! -L /var/lib/squad-panel ]]; then
  ln -sfn "${DATA_DIR}/servers" /var/lib/squad-panel
fi

set_env_key DATA_DIR "${DATA_DIR}"
set_env_key PANEL_GID "${PANEL_GID}"
if [[ -f "${REPO_DIR}/.env" ]]; then
  log "synchronized .env DATA_DIR and PANEL_GID"
fi

# squad-depot is a Docker named volume backed by ${DATA_DIR}/depot so SteamCMD's
# game files are kept with the rest of the install, not at Docker's default path.
if docker volume inspect squad-depot >/dev/null 2>&1; then
  EXISTING=$(docker volume inspect squad-depot --format '{{index .Options "device"}}' 2>/dev/null || echo '')
  if [[ -n "$EXISTING" && "$EXISTING" != "${DATA_DIR}/depot" ]]; then
    warn "squad-depot volume backed by ${EXISTING} (expected ${DATA_DIR}/depot)."
    warn "Remove it manually (docker volume rm squad-depot) to re-bind."
  fi
else
  log "creating squad-depot volume bound to ${DATA_DIR}/depot"
  docker volume create \
    --driver local \
    --opt type=none --opt o=bind --opt device="${DATA_DIR}/depot" \
    squad-depot >/dev/null
fi

# Drop-in: when data lives under /home, ProtectHome=yes tmpfs-shadows the
# whole /home tree which blocks traversal to ${DATA_DIR}/... even with the
# leaves listed in ReadWritePaths. Only then disable ProtectHome and grant
# the extra DAC capabilities that traversal needs; a DATA_DIR outside /home
# (the common case: REPO_DIR/data under /opt, /srv, ...) keeps the unit's
# default hardening and only gets the extra ReadWritePaths.
# The backup RPCs run `docker compose` against the deploy's own compose file
# and env files. A base install uses the defaults; the dev stand installs with
#   PANEL_COMPOSE_FILE=docker/compose.stand.yml PANEL_COMPOSE_ENV_FILES=.env.stand,.release.env
# Both are paths relative to REPO_DIR (the bridge refuses anything else).
PANEL_COMPOSE_FILE="${PANEL_COMPOSE_FILE:-docker/compose.yml}"
PANEL_COMPOSE_ENV_FILES="${PANEL_COMPOSE_ENV_FILES:-.env}"

log "installing systemd drop-in for data-dir access"
mkdir -p "${UNIT_DIR}/panel-host-bridge.service.d"
case "${DATA_DIR}" in
/home/* | /root/*) DATA_UNDER_HOME=1 ;;
*) DATA_UNDER_HOME=0 ;;
esac

if [[ "$DATA_UNDER_HOME" -eq 1 ]]; then
  log "DATA_DIR is under /home — relaxing ProtectHome and granting DAC capabilities"
  cat > "${UNIT_DIR}/panel-host-bridge.service.d/install.conf" <<EOF
# Generated by install-host-bridge.sh — adjusts sandboxing so the bridge
# can reach its data tree under ${DATA_DIR} (DATA_DIR lives under /home):
#   - ProtectHome=no: need to traverse /home
#   - CAP_DAC_READ_SEARCH + CAP_DAC_OVERRIDE: home dirs often 750; bridge
#     runs uid=0 but the main unit's bounding set strips these caps. Keep
#     allowlist-based writability enforced by the Go code in the bridge.
#   - PANEL_DEPOT_HOST_PATH: for bind-mounted squad-depot volumes, Docker
#     does not populate /var/lib/docker/volumes/squad-depot/_data — the
#     bridge and api both read depot files from the bind-mount source.
#   - PANEL_BACKUP_DUMP_ROOT: LOG-3 (#51). The restic backup staging tree
#     (RESTIC_BACKUP_SOURCES=/data → backup_dump volume). The bridge copies a
#     flagged server's expiring rotated log under log-archive/ here before the
#     retention sweep deletes it, so the next snapshot archives it.
#   - PANEL_COMPOSE_DIR / PANEL_COMPOSE_FILE / PANEL_COMPOSE_ENV_FILES: the
#     deploy directory, compose file and env files the backup RPCs (snapshots,
#     run, restore) target. Without PANEL_COMPOSE_DIR they fail closed.
[Service]
ProtectHome=no
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE
Environment=PANEL_DEPOT_HOST_PATH=${DATA_DIR}/depot
Environment=PANEL_BACKUP_DUMP_ROOT=${DATA_DIR}/backup-dump
Environment=PANEL_COMPOSE_DIR=${REPO_DIR}
Environment=PANEL_COMPOSE_FILE=${PANEL_COMPOSE_FILE}
Environment=PANEL_COMPOSE_ENV_FILES=${PANEL_COMPOSE_ENV_FILES}
ReadWritePaths=${DATA_DIR}/servers
ReadWritePaths=${DATA_DIR}/depot
ReadWritePaths=${DATA_DIR}/backup-dump
EOF
else
  cat > "${UNIT_DIR}/panel-host-bridge.service.d/install.conf" <<EOF
# Generated by install-host-bridge.sh — grants access to the data tree at
# ${DATA_DIR} (outside /home, so the unit's default ProtectHome=yes and
# capability set are left untouched):
#   - PANEL_DEPOT_HOST_PATH: for bind-mounted squad-depot volumes, Docker
#     does not populate /var/lib/docker/volumes/squad-depot/_data — the
#     bridge and api both read depot files from the bind-mount source.
#   - PANEL_BACKUP_DUMP_ROOT: LOG-3 (#51). The restic backup staging tree
#     (RESTIC_BACKUP_SOURCES=/data → backup_dump volume). The bridge copies a
#     flagged server's expiring rotated log under log-archive/ here before the
#     retention sweep deletes it, so the next snapshot archives it.
[Service]
Environment=PANEL_DEPOT_HOST_PATH=${DATA_DIR}/depot
Environment=PANEL_BACKUP_DUMP_ROOT=${DATA_DIR}/backup-dump
ReadWritePaths=${DATA_DIR}/servers
ReadWritePaths=${DATA_DIR}/depot
ReadWritePaths=${DATA_DIR}/backup-dump
EOF
fi

systemctl daemon-reload

UNITS_CHANGED=0
if [[ "$(unit_fingerprint)" != "$UNITS_BEFORE" ]]; then
  UNITS_CHANGED=1
fi

# -------- 5. enable + start the socket unit --------------------------------

if ! systemctl is-enabled --quiet panel-host-bridge.socket; then
  systemctl enable panel-host-bridge.socket
fi
systemctl start panel-host-bridge.socket
log "panel-host-bridge.socket active on /run/panel-host-bridge/bridge.sock"

# `systemctl start` on the socket unit only ever (re)activates listening —
# an already-running panel-host-bridge.service keeps whatever binary was
# loaded into memory even after the file on disk changed underneath it.
# try-restart is a no-op when the service isn't running (socket-activation
# will start it fresh with the new binary on first connection).
# A changed unit or drop-in needs the same restart: systemd applies
# CapabilityBoundingSet, ReadWritePaths and the rest only when the process
# starts, so a daemon-reload alone leaves the old sandbox running (a unit
# without CAP_CHOWN made every sidecar launch fail with EPERM).
if [[ "$BIN_CHANGED" -eq 1 || "$UNITS_CHANGED" -eq 1 ]]; then
  log "binary or systemd unit changed — restarting panel-host-bridge.service"
  systemctl try-restart panel-host-bridge.service
else
  log "binary and units unchanged — leaving panel-host-bridge.service as-is"
fi

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
