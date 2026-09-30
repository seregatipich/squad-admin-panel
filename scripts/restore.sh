#!/usr/bin/env bash
# restore.sh — restore Postgres + Redis from the latest restic snapshot (INFRA-8).
#
# This is the MANUAL host-side acceptance procedure for the disaster-recovery
# criterion of #14: after `docker compose --profile backup down -v` (and wiping
# ${DATA_DIR}/{postgres,redis}), running `scripts/restore.sh --apply` restores
# the panel's data from the restic repository. It is a deliberate host operation,
# never run automatically by CI.
#
# Usage:
#   scripts/restore.sh                       # DRY RUN: print the plan + list snapshots, mutate nothing
#   scripts/restore.sh --apply               # DESTRUCTIVE: overwrite live Postgres + Redis from `latest`
#   scripts/restore.sh --apply --snapshot ID # DESTRUCTIVE: restore a specific restic snapshot id
#
# --snapshot selects which restic snapshot to restore (default `latest`). It
# accepts a restic short/long id (lowercase hex) or the literal `latest`; the
# backup-restore UI (INFRA-8-P1) drives this path through the host bridge with
# the operator-selected id.
#
# The backup service (profile `backup`) writes logical dumps into the backup_dump
# volume before each snapshot; this script restores the selected snapshot and loads
# those dumps back:
#   - Both dumps are staged under ${DATA_DIR}/backup-dump/restore and checked
#     BEFORE anything live is touched, so a snapshot without them changes nothing.
#   - The running worker-* services are stopped for the duration and started
#     again on exit, success or not. The api stays up: the host bridge runs this
#     script for the api's restore request and kills it when that connection
#     drops, so stopping the api would abort the restore halfway.
#   - Postgres: pg_restore --single-transaction --exit-on-error --clean
#     --if-exists into the running `postgres` service — a failure rolls the whole
#     restore back instead of leaving a half-dropped schema.
#   - Redis: the live dataset is moved aside, not deleted; the RDB is loaded via
#     a one-off redis-server, then converted to an AOF (the `redis` service runs
#     with --appendonly yes, so it boots from the AOF and would ignore a bare
#     dump.rdb). On any failure the previous dataset is put back and redis is
#     started again. The load and the AOF rewrite are bounded
#     (REDIS_READY_ATTEMPTS, REDIS_REWRITE_ATTEMPTS polls 0.3 s apart) and stop
#     as soon as the one-off redis-server exits.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# docker/compose.yml; an install whose .env predates COMPOSE_FILE finds it too.
export COMPOSE_FILE="${COMPOSE_FILE:-docker/compose.yml}"

# The file DATA_DIR is read from. The host bridge sets it, COMPOSE_FILE and
# COMPOSE_ENV_FILES from its PANEL_COMPOSE_* configuration (the stand:
# docker/compose.stand.yml with .env.stand,.release.env).
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose --profile backup)

# ── colors / logging ────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RST=$'\e[0m'; C_BOLD=$'\e[1m'; C_RED=$'\e[31m'; C_GREEN=$'\e[32m'
  C_YELLOW=$'\e[33m'; C_CYAN=$'\e[36m'
else
  C_RST=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

die() { printf '\n%bERROR:%b %s\n' "${C_RED}" "${C_RST}" "$1" >&2; exit 1; }
log() { printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RST}" "$1"; }
step() { printf '%b==>%b %s\n' "${C_CYAN}${C_BOLD}" "${C_RST}" "$1"; }
warn() { printf '%b!!%b %s\n' "${C_YELLOW}${C_BOLD}" "${C_RST}" "$1"; }

# ── args ────────────────────────────────────────────────────────────────────

APPLY=0
SNAPSHOT=latest
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run|--plan) APPLY=0 ;;
    --snapshot) shift; SNAPSHOT="${1:-}" ;;
    --snapshot=*) SNAPSHOT="${1#*=}" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (use --apply [--snapshot <id>], or no argument for a dry run)" ;;
  esac
  shift
done

# A restic snapshot id is an 8- or 64-char lowercase hex string; `latest` is the
# default. Reject anything else so the id cannot smuggle arguments into restic.
[[ "$SNAPSHOT" == "latest" || "$SNAPSHOT" =~ ^[a-f0-9]{8}([a-f0-9]{56})?$ ]] \
  || die "invalid snapshot id: $SNAPSHOT (expected a restic short/long id or 'latest')"

command -v docker >/dev/null 2>&1 || die "docker is not installed / not on PATH"
[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE (needed for RESTIC_* and POSTGRES_PASSWORD)"

# Resolve DATA_DIR the same way docker compose does (from .env, default ./data),
# for the host-side Redis data-dir manipulation.
DATA_DIR="$(grep -E '^DATA_DIR=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
DATA_DIR="${DATA_DIR:-./data}"
[[ "$DATA_DIR" = /* ]] || DATA_DIR="${REPO}/${DATA_DIR#./}"

# ── dry run (default, read-only) ────────────────────────────────────────────

if [[ "$APPLY" -eq 0 ]]; then
  step "DRY RUN — nothing will be modified. Re-run with --apply to restore."
  cat <<PLAN

  On --apply this script will, from restic snapshot '${SNAPSHOT}':
    1. Ensure the postgres service is up and healthy.
    2. restic restore ${SNAPSHOT} and stage admin.dump + dump.rdb under
       ${DATA_DIR}/backup-dump/restore; stop here if either is missing.
    3. Stop the running worker-* services (started again when the script exits).
    4. pg_restore --single-transaction --exit-on-error --clean --if-exists
       -h postgres -U admin -d admin admin.dump (drops and recreates every
       object and loads the dumped data, all or nothing).
    5. Stop redis, move ${DATA_DIR}/redis aside, load the restored dump.rdb,
       convert it to an AOF, and start redis again (the previous dataset is
       put back if this step fails).

  This OVERWRITES the live database and Redis dataset. Take a fresh snapshot
  first if the current data still matters.

PLAN
  step "Snapshots currently in the restic repository:"
  # The base image's entrypoint is `exec restic "$@"`, so override it to run
  # restic explicitly (otherwise the args become `restic restic snapshots`).
  "${COMPOSE[@]}" run --rm --entrypoint /bin/sh -T backup -c 'restic snapshots' \
    || die "restic snapshots failed (repository initialised? backup image built?)"
  echo
  log "Dry run complete. No data was changed."
  exit 0
fi

# ── apply (destructive) ─────────────────────────────────────────────────────

# Host view of the staging directory the backup container writes to /data/restore.
STAGE_DIR="${DATA_DIR}/backup-dump/restore"
REDIS_DIR="${DATA_DIR}/redis"
REDIS_ASIDE="${DATA_DIR}/redis.pre-restore"

stopped_workers=()
redis_stopped=0
redis_moved_aside=0

# Runs on every exit, after success or failure: puts the previous Redis dataset
# back if the new one never made it, starts redis and the stopped workers again,
# and drops the staged dumps (they would otherwise ride along in the next
# snapshot).
finish() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$redis_moved_aside" -eq 1 ]]; then
    warn "Restore failed — putting the previous Redis dataset back"
    rm -rf "${REDIS_DIR}/appendonlydir" "${REDIS_DIR}/dump.rdb"
    for item in appendonlydir dump.rdb; do
      if [[ -e "${REDIS_ASIDE}/${item}" ]]; then mv "${REDIS_ASIDE}/${item}" "${REDIS_DIR}/${item}"; fi
    done
    rmdir "$REDIS_ASIDE" 2>/dev/null || warn "left ${REDIS_ASIDE} in place — inspect it before the next restore"
  fi
  if [[ "$redis_stopped" -eq 1 ]]; then
    "${COMPOSE[@]}" up -d redis >/dev/null || warn "could not start redis again — run: docker compose up -d redis"
  fi
  if [[ ${#stopped_workers[@]} -gt 0 ]]; then
    "${COMPOSE[@]}" start "${stopped_workers[@]}" >/dev/null \
      || warn "could not start ${stopped_workers[*]} again — run: docker compose start ${stopped_workers[*]}"
  fi
  rm -rf "$STAGE_DIR"
  exit "$status"
}
trap finish EXIT

warn "Restoring will OVERWRITE the live Postgres database and Redis dataset."

# A leftover from a restore that died without its trap holds the only copy of
# an earlier dataset; never overwrite it.
[[ ! -e "$REDIS_ASIDE" ]] || die "${REDIS_ASIDE} exists (left by an interrupted restore) — inspect and remove it first"

step "Ensuring postgres is up and healthy"
"${COMPOSE[@]}" up -d postgres >/dev/null
for _ in $(seq 1 40); do
  health="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="postgres"{print $2}')"
  [[ "$health" == "healthy" ]] && break
  sleep 3
done
[[ "${health:-}" == "healthy" ]] || die "postgres did not become healthy in time"
log "postgres healthy"

step "Staging the dumps from snapshot ${SNAPSHOT}"
# Override the `exec restic "$@"` entrypoint so this runs as a shell script. The
# snapshot id crosses into the container via an env var (never interpolated into
# the single-quoted script body), and was regex-validated above.
"${COMPOSE[@]}" run --rm -e RESTORE_SNAPSHOT="$SNAPSHOT" --entrypoint /bin/sh -T backup -c '
  set -e
  rm -rf /tmp/restore /data/restore
  restic restore "$RESTORE_SNAPSHOT" --target /tmp/restore
  test -f /tmp/restore/data/postgres/admin.dump || { echo "no admin.dump in snapshot" >&2; exit 1; }
  test -f /tmp/restore/data/redis/dump.rdb || { echo "no redis dump.rdb in snapshot" >&2; exit 1; }
  mkdir -p /data/restore
  cp /tmp/restore/data/postgres/admin.dump /data/restore/admin.dump
  cp /tmp/restore/data/redis/dump.rdb /data/restore/dump.rdb
'
# Checked from the host too: a DATA_DIR that disagrees with the backup_dump
# volume would otherwise surface only after Postgres was overwritten.
for staged in admin.dump dump.rdb; do
  [[ -f "${STAGE_DIR}/${staged}" ]] || die "staged ${staged} missing at ${STAGE_DIR} (DATA_DIR in ${ENV_FILE} must match the backup_dump volume)"
done
log "admin.dump and dump.rdb staged"

step "Stopping the workers while the data is replaced"
running_services="$("${COMPOSE[@]}" ps --services --status running)"
while IFS= read -r service; do
  [[ "$service" == worker-* ]] && stopped_workers+=("$service")
done <<<"$running_services"
if [[ ${#stopped_workers[@]} -gt 0 ]]; then
  "${COMPOSE[@]}" stop "${stopped_workers[@]}" >/dev/null
  log "stopped ${stopped_workers[*]}"
else
  log "no worker running"
fi

step "Restoring Postgres from snapshot ${SNAPSHOT}"
"${COMPOSE[@]}" run --rm --entrypoint /bin/sh -T backup -c '
  set -e
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --single-transaction --exit-on-error --clean --if-exists -h postgres -U admin -d admin /data/restore/admin.dump
'
log "Postgres restored (pg_restore --single-transaction --clean --if-exists)"

step "Restoring Redis from the restored dump.rdb"
redis_stopped=1
"${COMPOSE[@]}" stop redis >/dev/null
mkdir -p "$REDIS_ASIDE"
redis_moved_aside=1
for item in appendonlydir dump.rdb; do
  if [[ -e "${REDIS_DIR}/${item}" ]]; then mv "${REDIS_DIR}/${item}" "${REDIS_ASIDE}/${item}"; fi
done
mkdir -p "$REDIS_DIR"
cp "${STAGE_DIR}/dump.rdb" "${REDIS_DIR}/dump.rdb"

# The redis service runs with --appendonly yes, so it loads its dataset from the
# AOF, not from dump.rdb. Boot a one-off server with AOF off to load the RDB,
# then CONFIG SET appendonly yes to rewrite the dataset into a fresh AOF. The
# server takes the service's password, which redis-cli sends from REDISCLI_AUTH.
# Both waits give up when the server exits or the attempt budget runs out, so a
# corrupt RDB fails the restore instead of hanging it.
"${COMPOSE[@]}" run --rm --no-deps \
  -e REDIS_READY_ATTEMPTS="${REDIS_READY_ATTEMPTS:-600}" \
  -e REDIS_REWRITE_ATTEMPTS="${REDIS_REWRITE_ATTEMPTS:-2000}" \
  -T redis sh -c '
  set -e
  rm -rf /data/appendonlydir /data/dump.rdb
  cp /restore/dump.rdb /data/dump.rdb
  redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --requirepass "$REDISCLI_AUTH" &
  pid=$!
  attempts=0
  until redis-cli ping 2>/dev/null | grep -q PONG; do
    kill -0 "$pid" 2>/dev/null || { echo "redis-server exited while loading dump.rdb" >&2; exit 1; }
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$REDIS_READY_ATTEMPTS" ]; then
      echo "redis-server did not answer PING after $attempts attempts" >&2
      kill "$pid" 2>/dev/null || true
      exit 1
    fi
    sleep 0.3
  done
  redis-cli config set appendonly yes >/dev/null
  sleep 1
  attempts=0
  until [ "$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_rewrite_in_progress:/{print \$2}")" = "0" ]; do
    kill -0 "$pid" 2>/dev/null || { echo "redis-server exited during the AOF rewrite" >&2; exit 1; }
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$REDIS_REWRITE_ATTEMPTS" ]; then
      echo "AOF rewrite still running after $attempts attempts" >&2
      kill "$pid" 2>/dev/null || true
      exit 1
    fi
    sleep 0.3
  done
  status="$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_last_bgrewrite_status:/{print \$2}")"
  [ "$status" = "ok" ] || { echo "AOF rewrite failed: $status" >&2; exit 1; }
  redis-cli shutdown nosave || true
  wait "$pid" 2>/dev/null || true
'
"${COMPOSE[@]}" up -d redis >/dev/null
redis_stopped=0
redis_moved_aside=0
rm -rf "$REDIS_ASIDE"
log "Redis restored (RDB loaded and converted to AOF)"

echo
log "Restore complete. The stopped workers start again now; verify the panel data."
