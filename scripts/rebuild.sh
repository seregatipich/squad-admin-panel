#!/usr/bin/env bash
# rebuild.sh — tear down all containers and data, then bootstrap from scratch.
#
# Usage: sudo ./scripts/rebuild.sh
#
# This is a DESTRUCTIVE operation: it drops the database, Redis, Caddy certs,
# per-server configs/saves, and the ~12 GB SteamCMD depot cache.
# Only .env secrets and the host bridge are preserved.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${REPO}/data"

# ── colors ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RST=$'\e[0m'; C_BOLD=$'\e[1m'; C_RED=$'\e[31m'; C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'; C_DIM=$'\e[2m'
else
  C_RST=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_DIM=''
fi

die() { printf '\n%bERROR:%b %s\n' "${C_RED}" "${C_RST}" "$1" >&2; exit 1; }
log() { printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RST}" "$1"; }

# ── guards ──────────────────────────────────────────────────────────────────

[[ "$(id -u)" -eq 0 ]] || die "run as root: sudo ./scripts/rebuild.sh"

cat <<WARN

${C_BOLD}${C_RED}▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${C_RST}
${C_BOLD}${C_RED}║${C_RST}   ${C_BOLD}REBUILD${C_RST} — this destroys ${C_BOLD}all panel data${C_RST}:                        ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}     - PostgreSQL database (users, servers, audit log)          ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}     - Redis state (streams, cache)                             ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}     - Caddy TLS certificates                                  ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}     - Per-server configs and saves                             ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}     - SteamCMD depot cache (~12 GB)                            ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}                                                                ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}║${C_RST}   ${C_DIM}Preserved: .env secrets, host bridge.${C_RST}                       ${C_BOLD}${C_RED}║${C_RST}
${C_BOLD}${C_RED}▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${C_RST}

WARN

read -r -p "  Type 'rebuild' to confirm: " answer
[[ "$answer" == "rebuild" ]] || { echo "  Aborted."; exit 0; }

echo

# ── step 1: stop everything ────────────────────────────────────────────────

printf '%b[1/5]%b Stopping containers...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
cd "${REPO}"
docker compose down --remove-orphans 2>/dev/null || true
log "containers stopped"

# ── step 2: remove docker volumes ──────────────────────────────────────────

printf '%b[2/5]%b Removing Docker volumes...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
docker compose down -v 2>/dev/null || true
log "compose volumes removed"

# ── step 3: wipe data directories (preserve depot) ─────────────────────────

printf '%b[3/6]%b Wiping all data directories...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
for sub in postgres redis caddy-data caddy-config backup-repo depot; do
  if [[ -d "${DATA_DIR}/${sub}" ]]; then
    rm -rf "${DATA_DIR:?}/${sub:?}"
    mkdir -p "${DATA_DIR}/${sub}"
    log "wiped ${sub}/"
  fi
done
if [[ -d "${DATA_DIR}/servers" ]]; then
  rm -rf "${DATA_DIR:?}/servers/"*
  log "wiped servers/ contents"
fi

# ── step 4: remove squad-depot Docker volume ───────────────────────────────

printf '%b[4/6]%b Removing squad-depot Docker volume...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
docker volume rm squad-depot 2>/dev/null && log "squad-depot volume removed" || log "squad-depot volume not found (ok)"

# ── step 4: rebuild images ─────────────────────────────────────────────────

printf '%b[5/6]%b Rebuilding Docker images (no cache)...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
docker compose build --no-cache --progress=plain
log "images rebuilt"

# ── step 6: bring stack up ─────────────────────────────────────────────────

printf '%b[6/6]%b Starting stack...\n' "${C_CYAN}${C_BOLD}" "${C_RST}"
docker compose up -d
log "containers started"

# ── wait for healthy ───────────────────────────────────────────────────────

printf '\n  Waiting for health checks (up to 3 min)...\n'
DEADLINE=$(( $(date +%s) + 180 ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  API_HEALTH=$(docker inspect -f '{{.State.Health.Status}}' squad-admin-panel-api-1 2>/dev/null || echo 'pending')
  MIG_STATE=$(docker inspect -f '{{.State.Status}}' squad-admin-panel-migrator-1 2>/dev/null || echo 'running')
  MIG_RC=$(docker inspect -f '{{.State.ExitCode}}' squad-admin-panel-migrator-1 2>/dev/null || echo '?')
  if [[ "$API_HEALTH" == "healthy" && "$MIG_STATE" == "exited" && "$MIG_RC" == "0" ]]; then
    break
  fi
  sleep 3
done

API_HEALTH=$(docker inspect -f '{{.State.Health.Status}}' squad-admin-panel-api-1 2>/dev/null || echo '?')
if [[ "$API_HEALTH" == "healthy" ]]; then
  APP_DOMAIN=$(grep '^APP_DOMAIN=' "${REPO}/.env" | cut -d= -f2)
  cat <<DONE

${C_BOLD}${C_GREEN}▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄${C_RST}
${C_BOLD}${C_GREEN}║${C_RST}   ${C_BOLD}Rebuild complete.${C_RST} Fresh database, first user claims Owner.   ${C_BOLD}${C_GREEN}║${C_RST}
${C_BOLD}${C_GREEN}▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀${C_RST}

  ${C_BOLD}Open${C_RST}  ${C_CYAN}https://${APP_DOMAIN}/${C_RST}

DONE
else
  printf '\n  %b⚠%b  Stack may still be starting. Check: docker compose ps\n\n' "${C_YELLOW}" "${C_RST}"
fi
