#!/usr/bin/env bash
# prune-test-dbs.sh — list, and with --yes drop, the test databases that piled up
# in the local Postgres.
#
# scripts/new-test-db.sh creates one `test_<slug>` database per caller, and the
# pre-push checklist keeps one per worktree (`test_prepush_<worktree directory>`)
# between pushes. Nothing removes them when the worktree is deleted, so they
# accumulate, each one a fully migrated database.
#
# A `test_*` database is a candidate when
#   - it is a `test_prepush_*` database and no worktree of this clone is named
#     for it any more (`git worktree list`; the main checkout counts), or
#   - --older-than DAYS is given and the database was created at least that many
#     days ago, whatever created it (a live worktree's database is recreated by
#     its next push, at the cost of a fresh migration).
# Databases with open connections are always skipped. Names that do not start
# with `test_` (admin, sqtmpl_*, sqworker_* — the suites sweep their own) are
# never listed.
#
# Worktrees are read from this clone only: a database that belongs to a worktree
# of another clone sharing the same Postgres looks orphaned from here. Dry run is
# the default for that reason.
#
# Usage:
#   bash scripts/prune-test-dbs.sh                      # list what would be dropped
#   bash scripts/prune-test-dbs.sh --older-than 14      # also list databases older than 14 days
#   bash scripts/prune-test-dbs.sh --yes [--older-than N]   # drop them
#
# The Postgres container is chosen like in new-test-db.sh (PG_CONTAINER,
# COMPOSE_PROJECT_NAME); PG_USER defaults to admin. The creation time is the
# modification time of the database's PG_VERSION file, which needs a superuser.
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)

die() {
  printf 'prune-test-dbs: %s\n' "$*" >&2
  exit 1
}

apply=0
older_than=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) apply=1 ;;
    --older-than)
      [ $# -ge 2 ] || die "--older-than needs a number of days"
      older_than=$2
      shift
      ;;
    *) die "usage: prune-test-dbs.sh [--older-than DAYS] [--yes]" ;;
  esac
  shift
done
case "$older_than" in
  '' | *[!0-9]*) [ -z "$older_than" ] || die "--older-than must be a whole number of days" ;;
esac

# Same normalisation as dbname_for_slug in new-test-db.sh, for the slug the
# pre-push checklist builds from a worktree directory name.
prepush_db_for_directory() {
  local base
  base=$(basename "$1" | cut -c1-40)
  printf 'test_prepush_%s' "$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_')"
}

container=$(bash "$repo_root/scripts/new-test-db.sh" --container)
PG_USER=${PG_USER:-admin}

worktrees=$(git -C "$repo_root" worktree list --porcelain) || die "git worktree list failed in $repo_root"
live_databases=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      directory=${line#worktree }
      [ -d "$directory" ] || continue
      live_databases="${live_databases}$(prepush_db_for_directory "$directory")
"
      ;;
  esac
done <<EOF
$worktrees
EOF

# age_days is -1 when the creation time cannot be read.
listing=$(docker exec "$container" psql -U "$PG_USER" -d "$PG_USER" -tA -F '|' -c "
  SELECT d.datname,
         COALESCE(EXTRACT(EPOCH FROM now() - (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification)::bigint / 86400, -1),
         (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)
  FROM pg_database d
  WHERE d.datname LIKE 'test!_%' ESCAPE '!' AND NOT d.datistemplate
  ORDER BY d.datname") || die "could not list databases in $container"

candidates=0
dropped=0
while IFS='|' read -r name age_days connections; do
  [ -n "$name" ] || continue
  case "$name" in
    test_*[!a-z0-9_]*) continue ;;
  esac
  reason=""
  case "$name" in
    test_prepush_*)
      # Names at the 63-byte limit may have been truncated and hashed, so the
      # worktree they belong to cannot be recomputed: leave them to --older-than.
      if [ ${#name} -lt 63 ] && ! printf '%s' "$live_databases" | grep -Fxq "$name"; then
        reason="its worktree no longer exists"
      fi
      ;;
  esac
  if [ -z "$reason" ] && [ -n "$older_than" ] && [ "$age_days" -ge "$older_than" ]; then
    reason="created ${age_days} days ago"
  fi
  [ -n "$reason" ] || continue

  candidates=$((candidates + 1))
  if [ "$connections" -gt 0 ]; then
    printf 'keep  %s (%s, but %s connection(s) are open)\n' "$name" "$reason" "$connections"
    continue
  fi
  if [ "$apply" -eq 1 ]; then
    docker exec "$container" psql -U "$PG_USER" -d "$PG_USER" -q -c \
      "DROP DATABASE IF EXISTS \"${name}\" WITH (FORCE)" >/dev/null ||
      die "failed to drop ${name}"
    printf 'drop  %s (%s)\n' "$name" "$reason"
    dropped=$((dropped + 1))
  else
    printf 'would drop  %s (%s)\n' "$name" "$reason"
  fi
done <<EOF
$listing
EOF

if [ "$apply" -eq 1 ]; then
  printf 'dropped %s of %s candidate database(s)\n' "$dropped" "$candidates"
else
  printf '%s candidate database(s); nothing was dropped — re-run with --yes to drop them\n' "$candidates"
fi
