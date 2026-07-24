#!/usr/bin/env bash
# test-fullstack-down-v.sh — automated FULL-STACK disaster-recovery acceptance
# for INFRA-8 (the P1 headline criterion of #219 / #14).
#
# Unlike scripts/test-backup-restore.sh (which proves the backup mechanism at the
# container level on the CI `docker` job), this exercises the WHOLE panel stack
# from docker-compose.yml:
#
#   1. docker compose --profile backup up -d          (bring the panel up)
#   2. seed a canary row (Postgres) + key (Redis) into the live, migrated stack
#   3. docker compose --profile backup run --rm backup backup   (force a snapshot)
#   4. docker compose --profile backup down -v  +  wipe the postgres/redis binds
#      (the literal `down -v` volume-destruction the acceptance criterion names)
#   5. scripts/restore.sh --apply                      (restore from restic)
#   6. bring the stack back up and assert:
#        - the api /health endpoint returns 200 (panel fully operational), and
#        - the seeded Postgres row + Redis key survived the destroy→restore.
#
# ── RUN-DEFERRED ──────────────────────────────────────────────────────────────
# This is NOT wired into CI. Building + running the entire compose stack twice
# plus a restic restore needs more than the self-hosted CI runner (2 vCPU / 4 GB)
# can host — see #219. It is a MANUAL acceptance run on a scratch host (or a
# larger runner) that has Docker and enough RAM, and it is DESTRUCTIVE to the
# local stack's data. It therefore refuses to run unless explicitly opted in:
#
#   RUN_FULLSTACK_DOWN_V=1 bash scripts/test-fullstack-down-v.sh
#
# The guard fails closed (non-zero exit, no assertions) rather than pretending to
# pass when the environment cannot host the run.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose --profile backup)

CANARY_TABLE="fullstack_canary"
CANARY_VALUE="FULLSTACK-down-v-${RANDOM}${RANDOM}"
REDIS_KEY="fullstack:canary"
REDIS_VALUE="FULLSTACK-redis-${RANDOM}${RANDOM}"

if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'; C_BOLD=$'\e[1m'; C_RST=$'\e[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''; C_RST=''
fi
step() { printf '%b==>%b %s\n' "${C_CYAN}${C_BOLD}" "${C_RST}" "$1"; }
ok() { printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RST}" "$1"; }
warn() { printf '%b!!%b %s\n' "${C_YELLOW}${C_BOLD}" "${C_RST}" "$1" >&2; }
fail() { printf '\n%bFAIL:%b %s\n' "${C_RED}${C_BOLD}" "${C_RST}" "$1" >&2; exit 1; }

# ── guard: explicit opt-in + preconditions (fail closed) ─────────────────────
if [[ "${RUN_FULLSTACK_DOWN_V:-0}" != "1" ]]; then
  warn "Run-deferred: this destroys the local stack's data and needs Docker + ample RAM."
  warn "It is not part of CI (exceeds the 2vCPU/4GB runner). To run it deliberately:"
  warn "  RUN_FULLSTACK_DOWN_V=1 bash scripts/test-fullstack-down-v.sh"
  exit 2
fi

command -v docker >/dev/null 2>&1 || fail "docker is not installed / not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
[[ -f "$ENV_FILE" ]] || fail "missing $ENV_FILE (needed for RESTIC_*, POSTGRES_PASSWORD, DATA_DIR)"

# Resolve DATA_DIR the way docker compose does (from .env, default ./data).
DATA_DIR="$(grep -E '^DATA_DIR=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
DATA_DIR="${DATA_DIR:-./data}"
[[ "$DATA_DIR" = /* ]] || DATA_DIR="${REPO}/${DATA_DIR#./}"

wait_api_health() {
  # The api container has no host port mapping; probe its in-container /health.
  for _ in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T api wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_pg_healthy() {
  for _ in $(seq 1 40); do
    local h
    h="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="postgres"{print $2}')"
    [[ "$h" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}

# ── 1. bring the panel up ────────────────────────────────────────────────────
step "Bringing the full panel stack up (docker compose --profile backup up -d --build)"
"${COMPOSE[@]}" up -d --build || fail "compose up failed"
wait_pg_healthy || fail "postgres never became healthy"
wait_api_health || fail "api /health never returned 200 on first boot"
ok "stack up, api healthy"

# ── 2. seed a canary into the live, migrated stack ───────────────────────────
step "Seeding a canary row (Postgres) and key (Redis)"
"${COMPOSE[@]}" exec -T postgres psql -U admin -d admin -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS ${CANARY_TABLE} (id int primary key, note text);" \
  -c "INSERT INTO ${CANARY_TABLE} (id, note) VALUES (1, '${CANARY_VALUE}') ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note;" \
  >/dev/null || fail "seeding postgres canary failed"
"${COMPOSE[@]}" exec -T redis redis-cli set "$REDIS_KEY" "$REDIS_VALUE" >/dev/null \
  || fail "seeding redis canary failed"
ok "canary seeded (pg row + redis key)"

# ── 3. force a snapshot through the backup service ───────────────────────────
step "Forcing a restic snapshot (docker compose --profile backup run --rm backup backup)"
"${COMPOSE[@]}" run --rm backup backup || fail "backup run failed"
ok "snapshot taken"

# ── 4. the literal down -v + wipe the binds ──────────────────────────────────
step "Destroying the stack and its volumes (docker compose --profile backup down -v)"
"${COMPOSE[@]}" down -v || fail "compose down -v failed"
# down -v drops the named volume definitions, but the postgres/redis volumes are
# bind-backed (device: \${DATA_DIR}/...), so their host trees persist. Wipe them
# to make the data loss real.
rm -rf "${DATA_DIR:?}/postgres"/* "${DATA_DIR:?}/redis"/* 2>/dev/null || true
ok "volumes destroyed and postgres/redis binds wiped"

# ── 5. restore from the restic backup ────────────────────────────────────────
step "Restoring from the latest restic snapshot (scripts/restore.sh --apply)"
bash scripts/restore.sh --apply || fail "restore.sh --apply failed"
ok "restore applied"

# ── 6. bring the panel back up and assert it is operational + data survived ──
step "Bringing the panel back up on the restored data"
"${COMPOSE[@]}" up -d || fail "compose up (post-restore) failed"
wait_pg_healthy || fail "postgres never became healthy after restore"
wait_api_health || fail "api /health did not return 200 after restore — panel NOT operational"
ok "panel operational after restore (api /health 200)"

step "Asserting the seeded data survived down -v → restore"
got_pg="$("${COMPOSE[@]}" exec -T postgres psql -U admin -d admin -tAc \
  "SELECT note FROM ${CANARY_TABLE} WHERE id = 1;" 2>/dev/null | tr -d '[:space:]')"
[[ "$got_pg" == "$CANARY_VALUE" ]] \
  || fail "postgres canary not restored (got '${got_pg}', want '${CANARY_VALUE}')"
ok "postgres canary row restored"

got_rd="$("${COMPOSE[@]}" exec -T redis redis-cli get "$REDIS_KEY" 2>/dev/null | tr -d '[:space:]')"
[[ "$got_rd" == "$REDIS_VALUE" ]] \
  || fail "redis canary not restored (got '${got_rd}', want '${REDIS_VALUE}')"
ok "redis canary key restored"

printf '\n%bPASS%b — full-stack down -v → restore verified: panel operational, Postgres + Redis data survived.\n' \
  "${C_GREEN}${C_BOLD}" "${C_RST}"
