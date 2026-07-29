#!/usr/bin/env bash
# test-backup-restore.sh — end-to-end proof of the INFRA-8 backup/restore mechanism.
#
# Runs entirely on `docker` (the only tool the CI `docker` job has). It exercises
# the EXACT dump commands the docker-compose.yml backup service runs in its
# PRE_COMMANDS, backs them up with restic, simulates `docker compose down -v` by
# destroying the databases, then restores from the latest snapshot into a fresh
# Postgres + Redis and asserts the seeded data survived. Prints PASS/FAIL and
# exits non-zero on any mismatch. All containers (and their anonymous volumes),
# the network, and the temp dir are removed on exit — `docker rm -fv`, not
# `-f` alone, since postgres/redis declare a VOLUME for their data dir and a
# bare `-f` orphans it. The script asserts this itself (see the two
# "leaked its anonymous volume" checks below) after a prior run silently
# leaked ~7.5 GB of these across the self-hosted CI runner's disk.
#
# Usage: bash scripts/test-backup-restore.sh

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SFX="infra8-$$-$RANDOM"
NET="net-${SFX}"
PG1="pg1-${SFX}"; PG2="pg2-${SFX}"
RD1="rd1-${SFX}"; RD2="rd2-${SFX}"
TOOL_IMG="squad-panel/restic:citest"
PG_IMG="postgres:16-alpine"
RD_IMG="redis:7-alpine"
TMP="$(mktemp -d)"

CANARY_TABLE="canary"
CANARY_VALUE="INFRA8-postgres-$RANDOM"
REDIS_KEY="infra8:canary"
REDIS_VALUE="INFRA8-redis-$RANDOM"
# LOG-3 (#51): a rotated log the bridge stages under backup-dump/log-archive/
# before the retention sweep deletes it. The staging tree is part of
# RESTIC_BACKUP_SOURCES=/data, so a snapshot must carry it through a restore.
LOG3_SERVER_ID="019dbaa5-1234-7abc-8def-0123456789ab"
LOG3_LOG_NAME="SquadGame-2026.06.26-12.00.00.log"
LOG3_VALUE="LOG3-archived-log-$RANDOM"

C_RED=$'\e[31m'; C_GREEN=$'\e[32m'; C_CYAN=$'\e[36m'; C_BOLD=$'\e[1m'; C_RST=$'\e[0m'
step() { printf '%b==>%b %s\n' "${C_CYAN}${C_BOLD}" "${C_RST}" "$1"; }
ok() { printf '  %b✓%b %s\n' "${C_GREEN}" "${C_RST}" "$1"; }
fail() { printf '\n%bFAIL:%b %s\n' "${C_RED}${C_BOLD}" "${C_RST}" "$1" >&2; exit 1; }

cleanup() {
  local code=$?
  docker rm -fv "$PG1" "$PG2" "$RD1" "$RD2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP" >/dev/null 2>&1 || true
  return "$code"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker is not installed / not on PATH"

# Shared, world-writable staging so the restic (root) and redis (uid 999)
# containers can both write into it.
mkdir -p "$TMP/dump" "$TMP/repo" "$TMP/restore" "$TMP/redis-restore"
chmod -R 0777 "$TMP"

# Toolbox = the image we ship. It carries restic, pg_dump/pg_restore/psql, and
# redis-cli. Override the resticker entrypoint so we can run ad-hoc commands.
tool() {
  docker run --rm --network "$NET" --entrypoint /bin/sh \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD=citest \
    -e POSTGRES_PASSWORD=admin -e PGPASSWORD=admin \
    -v "$TMP/dump:/data" -v "$TMP/repo:/repo" -v "$TMP/restore:/restore" \
    "$TOOL_IMG" -c "$1"
}

wait_pg() {
  for _ in $(seq 1 60); do
    docker exec "$1" pg_isready -U admin -d admin >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "postgres container $1 never became ready"
}
wait_redis() {
  for _ in $(seq 1 60); do
    [ "$(docker exec "$1" redis-cli ping 2>/dev/null)" = "PONG" ] && return 0
    sleep 1
  done
  fail "redis container $1 never answered PING"
}

# ── build the backup image ──────────────────────────────────────────────────
step "Building the restic backup image (docker/restic.Dockerfile)"
docker build -f docker/restic.Dockerfile -t "$TOOL_IMG" . >/dev/null || fail "image build failed"
ok "image $TOOL_IMG built"

step "Creating isolated network"
docker network create "$NET" >/dev/null
ok "network $NET"

# ── stand up + seed the source databases ────────────────────────────────────
step "Starting source Postgres + Redis and seeding known data"
docker run -d --name "$PG1" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=admin "$PG_IMG" >/dev/null
docker run -d --name "$RD1" --network "$NET" --network-alias redis \
  "$RD_IMG" redis-server --appendonly yes --save 60 1000 >/dev/null
# Neither container is given an explicit -v, so each gets an anonymous volume
# for its image's declared VOLUME (postgres: /var/lib/postgresql/data, redis:
# /data). Captured here so the removals below can assert they didn't leak.
PG1_VOL="$(docker inspect "$PG1" --format '{{(index .Mounts 0).Name}}')"
RD1_VOL="$(docker inspect "$RD1" --format '{{(index .Mounts 0).Name}}')"
wait_pg "$PG1"; wait_redis "$RD1"

docker exec "$PG1" psql -U admin -d admin -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE ${CANARY_TABLE} (id int primary key, note text);" \
  -c "INSERT INTO ${CANARY_TABLE} VALUES (1, '${CANARY_VALUE}');" >/dev/null \
  || fail "seeding postgres failed"
docker exec "$RD1" redis-cli set "$REDIS_KEY" "$REDIS_VALUE" >/dev/null || fail "seeding redis failed"
ok "seeded postgres row and redis key"

# ── run the EXACT compose PRE_COMMANDS, then restic backup ──────────────────
step "Producing logical dumps (same commands as compose PRE_COMMANDS)"
tool 'mkdir -p /data/postgres /data/redis
PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h postgres -U admin -d admin -Fc -f /data/postgres/admin.dump
redis-cli -h redis --rdb /data/redis/dump.rdb' || fail "dump commands failed"
[ -s "$TMP/dump/postgres/admin.dump" ] || fail "pg_dump produced no admin.dump"
[ -s "$TMP/dump/redis/dump.rdb" ] || fail "redis-cli --rdb produced no dump.rdb"
ok "admin.dump and dump.rdb written"

step "Staging a LOG-3 archived log under the backup-dump tree (as the bridge does)"
mkdir -p "$TMP/dump/log-archive/${LOG3_SERVER_ID}"
printf '%s\n' "$LOG3_VALUE" > "$TMP/dump/log-archive/${LOG3_SERVER_ID}/${LOG3_LOG_NAME}"
ok "archived log staged at log-archive/${LOG3_SERVER_ID}/${LOG3_LOG_NAME}"

step "restic init + backup + forget --prune (asserting retention flags)"
tool 'restic init' || fail "restic init failed"
tool 'restic backup /data' || fail "restic backup failed"
tool 'restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune' \
  || fail "restic forget with retention flags failed"
tool 'restic snapshots' >/dev/null || fail "restic snapshots failed"
ok "snapshot created and retention accepted"

# ── simulate `docker compose down -v` ───────────────────────────────────────
step "Destroying the source databases (simulating down -v)"
docker rm -fv "$PG1" "$RD1" >/dev/null
docker volume inspect "$PG1_VOL" >/dev/null 2>&1 && fail "docker rm -fv leaked PG1's anonymous volume ($PG1_VOL)"
docker volume inspect "$RD1_VOL" >/dev/null 2>&1 && fail "docker rm -fv leaked RD1's anonymous volume ($RD1_VOL)"
ok "source postgres + redis removed (including anonymous volumes)"

# ── restore into a FRESH stack ──────────────────────────────────────────────
step "Starting fresh empty Postgres + Redis"
docker run -d --name "$PG2" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=admin "$PG_IMG" >/dev/null
PG2_VOL="$(docker inspect "$PG2" --format '{{(index .Mounts 0).Name}}')"
wait_pg "$PG2"

step "Restoring Postgres from the latest snapshot"
tool 'rm -rf /restore/* ; restic restore latest --target /restore
test -f /restore/data/postgres/admin.dump || { echo missing-dump >&2; exit 1; }
PGPASSWORD=admin pg_restore --clean --if-exists -h postgres -U admin -d admin /restore/data/postgres/admin.dump
cp /restore/data/redis/dump.rdb /data/redis/dump.rdb' || fail "postgres restore failed"
ok "pg_restore --clean --if-exists completed"

step "Converting restored RDB to an AOF (redis runs --appendonly yes)"
cp "$TMP/dump/redis/dump.rdb" "$TMP/redis-restore/dump.rdb"
# The restored redis boots with --appendonly yes, which loads the AOF and would
# ignore a bare dump.rdb. Boot a one-off server with AOF off to load the RDB,
# then CONFIG SET appendonly yes so it rewrites the dataset into a fresh AOF.
docker run --rm --entrypoint /bin/sh -v "$TMP/redis-restore:/data" "$RD_IMG" -c '
  set -e
  redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" &
  pid=$!
  until redis-cli ping 2>/dev/null | grep -q PONG; do sleep 0.3; done
  redis-cli config set appendonly yes >/dev/null
  sleep 1
  until [ "$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_rewrite_in_progress:/{print \$2}")" = "0" ]; do sleep 0.3; done
  status="$(redis-cli info persistence | tr -d "\r" | awk -F: "/^aof_last_bgrewrite_status:/{print \$2}")"
  [ "$status" = "ok" ] || { echo "aof rewrite failed: $status" >&2; exit 1; }
  redis-cli shutdown nosave || true
  wait "$pid" 2>/dev/null || true
' || fail "RDB->AOF conversion failed"
ok "AOF rebuilt from restored RDB"

step "Starting fresh Redis on the restored AOF"
docker run -d --name "$RD2" --network "$NET" --network-alias redis \
  -v "$TMP/redis-restore:/data" "$RD_IMG" \
  redis-server --dir /data --appendonly yes --save 60 1000 >/dev/null
wait_redis "$RD2"

# ── assertions ──────────────────────────────────────────────────────────────
step "Asserting the seeded data survived the restore"
got_pg="$(docker exec "$PG2" psql -U admin -d admin -tAc \
  "SELECT note FROM ${CANARY_TABLE} WHERE id = 1;" 2>/dev/null | tr -d '[:space:]')"
[ "$got_pg" = "$CANARY_VALUE" ] || fail "postgres row not restored (got '${got_pg}', want '${CANARY_VALUE}')"
ok "postgres canary row restored"

got_rd="$(docker exec "$RD2" redis-cli get "$REDIS_KEY" 2>/dev/null)"
[ "$got_rd" = "$REDIS_VALUE" ] || fail "redis key not restored (got '${got_rd}', want '${REDIS_VALUE}')"
ok "redis canary key restored"

step "Asserting the LOG-3 archived log survived the snapshot + restore"
log3_restored="$TMP/restore/data/log-archive/${LOG3_SERVER_ID}/${LOG3_LOG_NAME}"
[ -f "$log3_restored" ] || fail "archived log missing after restore ($log3_restored)"
got_log3="$(tr -d '[:space:]' < "$log3_restored")"
[ "$got_log3" = "$LOG3_VALUE" ] \
  || fail "archived log content not restored (got '${got_log3}', want '${LOG3_VALUE}')"
ok "LOG-3 archived log restored from snapshot"

# ── reclaim the restored stack up front (the EXIT trap below is now a no-op
# for containers, and still handles the network + temp dir) ─────────────────
step "Reclaiming the restored stack and asserting no anonymous volumes leaked"
docker rm -fv "$PG2" "$RD2" >/dev/null
docker volume inspect "$PG2_VOL" >/dev/null 2>&1 && fail "docker rm -fv leaked PG2's anonymous volume ($PG2_VOL)"
ok "restored postgres + redis removed (including anonymous volumes)"

printf '\n%bPASS%b — backup → down -v → restore round-trip verified for Postgres, Redis, and LOG-3 archived logs.\n' \
  "${C_GREEN}${C_BOLD}" "${C_RST}"
