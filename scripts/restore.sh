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
#   scripts/restore.sh            # DRY RUN: print the plan + list snapshots, mutate nothing
#   scripts/restore.sh --apply    # DESTRUCTIVE: overwrite the live Postgres + Redis data
#
# The backup service (profile `backup`) writes logical dumps into the backup_dump
# volume before each snapshot; this script restores the newest snapshot and loads
# those dumps back:
#   - Postgres: pg_restore --clean --if-exists into the running `postgres` service.
#   - Redis: the RDB is loaded via a one-off redis-server, then converted to an
#     AOF (the `redis` service runs with --appendonly yes, so it boots from the
#     AOF and would ignore a bare dump.rdb).

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

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
case "${1:-}" in
  --apply) APPLY=1 ;;
  ''|--dry-run|--plan) APPLY=0 ;;
  -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  *) die "unknown argument: $1 (use --apply, or no argument for a dry run)" ;;
esac

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

  On --apply this script will, from the latest restic snapshot:
    1. Ensure the postgres service is up and healthy.
    2. restic restore latest into the backup container.
    3. pg_restore --clean --if-exists -h postgres -U admin -d admin admin.dump
       (drops and recreates every object, then loads the dumped data).
    4. Stop redis, replace ${DATA_DIR}/redis with the restored dump.rdb,
       convert it to an AOF, and start redis again.

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

warn "Restoring will OVERWRITE the live Postgres database and Redis dataset."

step "Ensuring postgres is up and healthy"
"${COMPOSE[@]}" up -d postgres >/dev/null
for _ in $(seq 1 40); do
  health="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="postgres"{print $2}')"
  [[ "$health" == "healthy" ]] && break
  sleep 3
done
[[ "${health:-}" == "healthy" ]] || die "postgres did not become healthy in time"
log "postgres healthy"

step "Restoring Postgres from the latest snapshot"
# Override the `exec restic "$@"` entrypoint so this runs as a shell script.
"${COMPOSE[@]}" run --rm --entrypoint /bin/sh -T backup -c '
  set -e
  rm -rf /tmp/restore
  restic restore latest --target /tmp/restore
  test -f /tmp/restore/data/postgres/admin.dump || { echo "no admin.dump in snapshot" >&2; exit 1; }
  PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists -h postgres -U admin -d admin /tmp/restore/data/postgres/admin.dump
  mkdir -p /data/redis
  cp /tmp/restore/data/redis/dump.rdb /data/redis/dump.rdb
'
log "Postgres restored (pg_restore --clean --if-exists)"

step "Restoring Redis from the restored dump.rdb"
"${COMPOSE[@]}" stop redis >/dev/null
rm -rf "${DATA_DIR}/redis/appendonlydir" "${DATA_DIR}/redis/dump.rdb"
[[ -f "${DATA_DIR}/backup-dump/redis/dump.rdb" ]] || die "restored dump.rdb missing at ${DATA_DIR}/backup-dump/redis/dump.rdb"
cp "${DATA_DIR}/backup-dump/redis/dump.rdb" "${DATA_DIR}/redis/dump.rdb"

# The redis service runs with --appendonly yes, so it loads its dataset from the
# AOF, not from dump.rdb. Boot a one-off server with AOF off to load the RDB,
# then CONFIG SET appendonly yes to rewrite the dataset into a fresh AOF.
"${COMPOSE[@]}" run --rm --no-deps -T redis sh -c '
  set -e
  redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" &
  pid=$!
  until redis-cli ping 2>/dev/null | grep -q PONG; do sleep 0.3; done
  redis-cli config set appendonly yes >/dev/null
  sleep 1
  until [ "$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_rewrite_in_progress:/{print \$2}")" = "0" ]; do sleep 0.3; done
  status="$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_last_bgrewrite_status:/{print \$2}")"
  [ "$status" = "ok" ] || { echo "AOF rewrite failed: $status" >&2; exit 1; }
  redis-cli shutdown nosave || true
  wait "$pid" 2>/dev/null || true
'
"${COMPOSE[@]}" up -d redis >/dev/null
log "Redis restored (RDB loaded and converted to AOF)"

echo
log "Restore complete. Verify the panel data, then restart dependent services if needed."
