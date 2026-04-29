#!/usr/bin/env bash
# bootstrap.sh — installer with live progress.
#
# Usage: sudo ./scripts/bootstrap.sh
#
# Idempotent. Re-running only does the missing steps; never rotates secrets.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${REPO}/data"
LOG_DIR="${REPO}/.bootstrap-logs"
STAGE_COUNT=7
STAGE_IDX=0
STAGE_START=0
SCRIPT_START=$(date +%s)

# -------- TTY-aware color palette -----------------------------------------

if [[ -t 1 ]]; then
  C_RST=$'\e[0m'
  C_BOLD=$'\e[1m'
  C_DIM=$'\e[2m'
  C_RED=$'\e[31m'
  C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'
  C_BLUE=$'\e[34m'
  C_MAGENTA=$'\e[35m'
  C_CYAN=$'\e[36m'
  C_GRAY=$'\e[90m'
  HAS_TTY=1
else
  C_RST=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_MAGENTA=''; C_CYAN=''; C_GRAY=''
  HAS_TTY=0
fi

# -------- helpers ---------------------------------------------------------

die() {
  printf '\n%bERROR:%b %s\n' "${C_RED}" "${C_RST}" "$1" >&2
  exit 1
}

hms() {
  local s=$1
  printf '%dm%02ds' $((s/60)) $((s%60))
}

banner() {
  cat <<BAN

${C_BOLD}${C_CYAN}▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${C_RST}
${C_BOLD}${C_CYAN}║${C_RST}   ${C_BOLD}Squad Admin Panel${C_RST} · installer                                ${C_BOLD}${C_CYAN}║${C_RST}
${C_BOLD}${C_CYAN}║${C_RST}   ${C_DIM}everything under ${REPO}${C_RST}
${C_BOLD}${C_CYAN}▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${C_RST}
BAN
}

stage_begin() {
  STAGE_IDX=$((STAGE_IDX + 1))
  STAGE_START=$(date +%s)
  local pct=$(( STAGE_IDX * 100 / STAGE_COUNT ))
  printf '\n%b┌─[%d/%d · %d%%]─ %s%b\n' \
    "${C_CYAN}${C_BOLD}" "${STAGE_IDX}" "${STAGE_COUNT}" "$pct" "$1" "${C_RST}"
}

stage_end() {
  local dur=$(( $(date +%s) - STAGE_START ))
  printf '%b└─ %b✓%b %s %b(%s)%b\n' \
    "${C_CYAN}" "${C_GREEN}${C_BOLD}" "${C_RST}${C_CYAN}" "done" "${C_DIM}" "$(hms "$dur")" "${C_RST}"
}

step_ok()   {
  if [[ -n "${2:-}" ]]; then
    printf '  %b✓%b %s %b(%s)%b\n' "${C_GREEN}" "${C_RST}" "$1" "${C_DIM}" "$2" "${C_RST}"
  else
    printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RST}" "$1"
  fi
}
step_skip() {
  if [[ -n "${2:-}" ]]; then
    printf '  %b○%b %s %b(%s)%b\n' "${C_GRAY}" "${C_RST}" "$1" "${C_DIM}" "$2" "${C_RST}"
  else
    printf '  %b○%b %s\n' "${C_GRAY}" "${C_RST}" "$1"
  fi
}
step_warn() { printf '  %b⚠%b %s\n' "${C_YELLOW}" "${C_RST}" "$1" >&2; }
step_info() { printf '  %b·%b %s\n' "${C_DIM}" "${C_RST}" "$1"; }

# Run a command with a spinner. Captures output to a log; shows last lines on failure.
# Usage: spin_run "label" [--timeout=N] -- cmd args...
spin_run() {
  local label="$1"; shift
  local log="${LOG_DIR}/${STAGE_IDX}-$(echo "$label" | tr ' /' '__' | head -c 40).log"
  local start=$(date +%s)

  if [[ ${HAS_TTY} -eq 0 ]]; then
    # Non-TTY: no spinner, just run
    if "$@" >"$log" 2>&1; then
      step_ok "$label" "$(hms $(( $(date +%s) - start )))"
      return 0
    else
      local rc=$?
      printf '  %b✗%b %s %b(failed after %s)%b\n' "${C_RED}" "${C_RST}" "$label" "${C_DIM}" "$(hms $(( $(date +%s) - start )))" "${C_RST}"
      printf '  %blast 30 lines of %s:%b\n' "${C_DIM}" "$log" "${C_RST}"
      tail -30 "$log" | sed 's/^/    /'
      return $rc
    fi
  fi

  "$@" >"$log" 2>&1 &
  local pid=$!
  # Braille spinner — works on any UTF-8 terminal
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    local c=${spin:$((i % ${#spin})):1}
    local el=$(( $(date +%s) - start ))
    printf '\r  %b%s%b %s %b%s%b\033[K' \
      "${C_CYAN}" "$c" "${C_RST}" "$label" "${C_DIM}" "$(hms "$el")" "${C_RST}"
    i=$((i + 1))
    sleep 0.1
  done
  local rc=0
  wait "$pid" || rc=$?
  local dur=$(( $(date +%s) - start ))
  printf '\r\033[K'
  if [[ $rc -eq 0 ]]; then
    step_ok "$label" "$(hms "$dur")"
  else
    printf '  %b✗%b %s %b(failed after %s)%b\n' "${C_RED}" "${C_RST}" "$label" "${C_DIM}" "$(hms "$dur")" "${C_RST}"
    printf '  %blast 30 lines of %s:%b\n' "${C_DIM}" "$log" "${C_RST}"
    tail -30 "$log" | sed 's/^/    /'
    return $rc
  fi
}

# trap for cleanup on abort
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && $rc -ne 130 ]]; then
    printf '\n%b●%b Installation aborted. Logs: %s\n' "${C_RED}" "${C_RST}" "${LOG_DIR}" >&2
  fi
  exit $rc
}
trap on_exit EXIT
trap 'printf "\n%bCancelled by user.%b\n" "${C_YELLOW}" "${C_RST}"; exit 130' INT TERM

# -------- preflight guards ------------------------------------------------

[[ "$(id -u)" -eq 0 ]] || die "run as root: sudo ./scripts/bootstrap.sh"

if [[ -z "${SUDO_USER:-}" ]]; then
  OWNER="root"
else
  OWNER="$SUDO_USER"
fi

mkdir -p "${LOG_DIR}"

banner

# ============ [1/7] Preflight ============================================

stage_begin "preflight: distro, Docker, openssl"

if grep -qE 'Ubuntu (22\.04|24\.04)|Debian GNU/Linux 1[2-9]' /etc/os-release; then
  step_ok "supported OS: $(grep -oE 'Ubuntu 2[24]\.04|Debian GNU/Linux 1[2-9]' /etc/os-release | head -1)"
else
  die "Unsupported OS. Need Ubuntu 22.04 / 24.04 LTS or Debian 12+."
fi

if command -v docker >/dev/null; then
  step_ok "Docker present" "$(docker --version | awk '{print $3}' | tr -d ,)"
else
  die "Docker not installed. See https://docs.docker.com/engine/install/"
fi

if docker compose version >/dev/null 2>&1; then
  step_ok "Compose v2 present" "$(docker compose version --short 2>/dev/null || echo '?')"
else
  die "Docker Compose v2 plugin missing. apt install docker-compose-plugin."
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon not running or not accessible. Try: sudo systemctl start docker"
fi

command -v openssl >/dev/null || die "openssl required for secret generation"
step_ok "openssl present"
step_ok "disk free: $(df -h --output=avail "${REPO}" | tail -1 | tr -d ' ') on $(df --output=target "${REPO}" | tail -1)"

stage_end

# ============ [2/7] Host bridge ==========================================

stage_begin "host bridge (systemd unit + socket + 'panel' group)"

step_info "running scripts/install-host-bridge.sh"
spin_run "install-host-bridge.sh" bash "${REPO}/scripts/install-host-bridge.sh"

stage_end

# ============ [3/7] Data tree inventory (install-host-bridge.sh creates it) ===

stage_begin "data tree"

for sub in postgres redis caddy-data caddy-config backup-repo depot servers; do
  [[ -d "${DATA_DIR}/${sub}" ]] || die "missing ${DATA_DIR}/${sub} (install-host-bridge.sh should have created it)"
done
step_ok "${DATA_DIR}/{postgres,redis,caddy-data,caddy-config,backup-repo,depot,servers}"

if [[ -L /var/lib/squad-panel ]] && [[ "$(readlink /var/lib/squad-panel)" == "${DATA_DIR}/servers" ]]; then
  step_ok "/var/lib/squad-panel → ${DATA_DIR}/servers"
else
  die "/var/lib/squad-panel symlink missing or wrong target"
fi

if docker volume inspect squad-depot >/dev/null 2>&1; then
  dev=$(docker volume inspect squad-depot --format '{{index .Options "device"}}')
  if [[ "$dev" == "${DATA_DIR}/depot" ]]; then
    step_ok "squad-depot volume" "bind → ${DATA_DIR}/depot"
  else
    step_warn "squad-depot volume backed by ${dev}, expected ${DATA_DIR}/depot"
  fi
fi

stage_end

# ============ [4/7] .env + DATA_DIR =====================================

stage_begin ".env (secrets + config)"

if [[ -f "${REPO}/.env" ]]; then
  step_skip "existing .env preserved" "won't rotate secrets"
  if ! grep -q '^DATA_DIR=' "${REPO}/.env"; then
    echo "DATA_DIR=${DATA_DIR}" >> "${REPO}/.env"
    step_ok "DATA_DIR appended"
  else
    step_ok "DATA_DIR already set"
  fi
else
  APP_DOMAIN_DEFAULT="${APP_DOMAIN:-squad-panel.lan}"
  PG_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
  ENC_KEY=$(openssl rand -base64 32)
  SESS=$(openssl rand -base64 32)
  PANEL_GID=$(getent group panel | cut -d: -f3)
  cat > "${REPO}/.env" <<EOF
APP_DOMAIN=${APP_DOMAIN_DEFAULT}
TLS_ISSUER=internal
ACME_EMAIL=admin@example.com
POSTGRES_PASSWORD=${PG_PW}
APP_ENCRYPTION_KEY=${ENC_KEY}
SESSION_SECRET=${SESS}
DATABASE_URL=postgres://admin:${PG_PW}@postgres:5432/admin
REDIS_URL=redis://redis:6379
BRIDGE_SOCKET=/run/panel-host-bridge/bridge.sock
COOKIE_SECURE=false
LOG_LEVEL=info
PANEL_GID=${PANEL_GID}
DATA_DIR=${DATA_DIR}
EOF
  chmod 600 "${REPO}/.env"
  chown "${OWNER}:${OWNER}" "${REPO}/.env" 2>/dev/null || true
  step_ok "wrote .env" "mode 600, owner ${OWNER}"
  echo
  printf '  %b⚠  SAVE THIS KEY OFFLINE — losing it = cannot decrypt stored RCON passwords:%b\n' "${C_YELLOW}${C_BOLD}" "${C_RST}"
  printf '  %bAPP_ENCRYPTION_KEY=%s%b\n\n' "${C_CYAN}" "${ENC_KEY}" "${C_RST}"
fi

APP_DOMAIN=$(awk -F= '/^APP_DOMAIN=/ {print $2}' "${REPO}/.env")
step_info "APP_DOMAIN = ${APP_DOMAIN}"

stage_end

# ============ [5/7] /etc/hosts for dev domains ==========================

stage_begin "/etc/hosts (dev-domain mapping)"

if [[ "$APP_DOMAIN" =~ \.(lan|localhost|test|local)$ ]]; then
  if grep -qE "^[^#]*[[:space:]]${APP_DOMAIN}([[:space:]]|$)" /etc/hosts; then
    step_skip "127.0.0.1 ${APP_DOMAIN}" "already present"
  else
    echo "127.0.0.1 ${APP_DOMAIN}" >> /etc/hosts
    step_ok "appended 127.0.0.1 ${APP_DOMAIN}"
  fi
else
  step_skip "not a dev domain (${APP_DOMAIN}) — point DNS at this host yourself"
fi

stage_end

# ============ [6/7] Docker images =======================================

stage_begin "docker compose build (first run: ~2 min)"

cd "${REPO}"
spin_run "building api + web + workers" docker compose build --progress=plain

stage_end

# ============ [7/7] Bring stack up + wait for healthy ===================

stage_begin "docker compose up + healthchecks"

# Step A: start services
spin_run "starting all containers" docker compose up -d

# Step B: wait for healthy — with per-container progress
step_info "waiting for migrator to complete + api/caddy to pass health check"

DEADLINE=$(( $(date +%s) + 180 ))
MIGRATOR_DONE=0
API_HEALTHY=0
CADDY_HEALTHY=0
PRINTED_TABLE=0

while [[ $(date +%s) -lt $DEADLINE ]]; do
  MIG_STATE=$(docker inspect -f '{{.State.Status}}' squad-admin-panel-migrator-1 2>/dev/null || echo 'missing')
  MIG_RC=$(docker inspect -f '{{.State.ExitCode}}' squad-admin-panel-migrator-1 2>/dev/null || echo '?')
  API_HEALTH=$(docker inspect -f '{{.State.Health.Status}}' squad-admin-panel-api-1 2>/dev/null || echo 'pending')
  CADDY_HEALTH=$(docker inspect -f '{{.State.Health.Status}}' squad-admin-panel-caddy-1 2>/dev/null || echo 'pending')

  if [[ $HAS_TTY -eq 1 ]]; then
    # redraw 4-line table in place
    if [[ $PRINTED_TABLE -eq 1 ]]; then printf '\033[4A'; fi
    printf '  %b%-10s%b %s\033[K\n' "${C_DIM}" "migrator:" "${C_RST}" \
      "$(if [[ "$MIG_STATE" == "exited" && "$MIG_RC" == "0" ]]; then printf '%b✓ exited 0%b' "${C_GREEN}" "${C_RST}"; else printf '%b%s%b' "${C_YELLOW}" "$MIG_STATE" "${C_RST}"; fi)"
    printf '  %b%-10s%b %s\033[K\n' "${C_DIM}" "api:" "${C_RST}" \
      "$(if [[ "$API_HEALTH" == "healthy" ]]; then printf '%b✓ healthy%b' "${C_GREEN}" "${C_RST}"; else printf '%b%s%b' "${C_YELLOW}" "$API_HEALTH" "${C_RST}"; fi)"
    printf '  %b%-10s%b %s\033[K\n' "${C_DIM}" "caddy:" "${C_RST}" \
      "$(if [[ "$CADDY_HEALTH" == "healthy" ]]; then printf '%b✓ healthy%b' "${C_GREEN}" "${C_RST}"; else printf '%b%s%b' "${C_YELLOW}" "$CADDY_HEALTH" "${C_RST}"; fi)"
    EL=$(( $(date +%s) - STAGE_START ))
    printf '  %b%-10s %s · deadline in %ds%b\033[K\n' "${C_DIM}" "elapsed:" "$(hms "$EL")" $(( DEADLINE - $(date +%s) )) "${C_RST}"
    PRINTED_TABLE=1
  fi

  [[ "$MIG_STATE" == "exited" && "$MIG_RC" == "0" ]] && MIGRATOR_DONE=1
  [[ "$API_HEALTH" == "healthy" ]] && API_HEALTHY=1
  [[ "$CADDY_HEALTH" == "healthy" ]] && CADDY_HEALTHY=1

  if [[ $MIGRATOR_DONE -eq 1 && $API_HEALTHY -eq 1 && $CADDY_HEALTHY -eq 1 ]]; then
    break
  fi
  sleep 2
done

if [[ $MIGRATOR_DONE -ne 1 || $API_HEALTHY -ne 1 || $CADDY_HEALTHY -ne 1 ]]; then
  step_warn "not all checks passed within 3 min — stack may still come up. 'docker compose logs' to investigate."
else
  step_ok "stack healthy"
fi

stage_end

# ============ Summary =====================================================

TOTAL=$(( $(date +%s) - SCRIPT_START ))

cat <<SUMMARY

${C_BOLD}${C_GREEN}▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${C_RST}
${C_BOLD}${C_GREEN}║${C_RST}   ${C_BOLD}✓ ready in $(hms "$TOTAL")${C_RST}
${C_BOLD}${C_GREEN}▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${C_RST}

  ${C_BOLD}Open${C_RST}      ${C_CYAN}https://${APP_DOMAIN}/${C_RST}
  ${C_BOLD}Data${C_RST}      ${DATA_DIR}/
  ${C_BOLD}Config${C_RST}    ${REPO}/.env
  ${C_BOLD}Logs${C_RST}      ${LOG_DIR}/

  ${C_DIM}Self-signed cert → click through browser warning once.${C_RST}
  ${C_DIM}First visit lands on /setup: org → owner user → done.${C_RST}

  ${C_BOLD}Useful${C_RST}
    ${C_DIM}docker compose ps${C_RST}                            stack state
    ${C_DIM}docker compose logs -f api${C_RST}                   tail API
    ${C_DIM}docker compose logs -f worker-rcon${C_RST}           tail RCON worker
    ${C_DIM}sg panel -c "bash scripts/verify-bridge.sh"${C_RST}  bridge smoke test
    ${C_DIM}sudo ./scripts/uninstall.sh${C_RST}                  tear everything down

SUMMARY
