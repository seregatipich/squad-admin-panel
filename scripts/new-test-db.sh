#!/usr/bin/env bash
# new-test-db.sh — provision an isolated, migrated test database for one agent/wave.
#
# Kills the setup footguns that repeatedly cost parallel agents time:
#   - the local Postgres password is the POSTGRES_PASSWORD token in .env, NOT "admin";
#   - from the host, Postgres is reachable at 127.0.0.1:5432 (the .env DATABASE_URL
#     uses the docker-internal host "postgres", which does not resolve on the host);
#   - the API integration harness reads TEST_DATABASE_URL (reusePublicSchema →
#     HOST_DB_URL), while workers/migrate read DATABASE_URL — so BOTH must point at
#     the same isolated DB or tests silently hit the shared `admin` database;
#   - the API harness throws when TEST_REDIS_URL is unset (it has no default, so a
#     run can never flush the stack's own Redis), and Redis requires the
#     REDIS_PASSWORD token from .env.
#
# Usage:
#   eval "$(bash scripts/new-test-db.sh <slug>)"     # provision + export the vars
#   bash scripts/new-test-db.sh <slug>               # just print the export lines
#   bash scripts/new-test-db.sh --drop <slug>        # drop a database this created
#
# Progress goes to stderr; ONLY the three `export …` lines go to stdout, so the
# command is safe to `eval`. Idempotent: re-running for the same slug reuses the DB.
#
# TEST_REDIS_URL names an isolated Redis logical database in 8..15 derived from the
# slug, so worktrees with different slugs rarely land on the same one. The API
# harness still remaps the index per Vitest worker slot (workerRedisDatabase in
# apps/api/test/integration/isolated-db.ts), so worktrees that must not share Redis
# state at all need their own Redis (see "Several worktrees" in
# docs/development/local-development.md).
#
# Env overrides:
#   PG_CONTAINER   Postgres container to exec into. Default: the one running
#                  postgres container (or the one of COMPOSE_PROJECT_NAME when that
#                  is set); the script fails and lists them when it cannot pick one.
#   PG_HOST        default 127.0.0.1
#   PG_PORT        default POSTGRES_HOST_PORT (environment, then .env), else 5432
#   PG_USER        default admin
#   REDIS_HOST     default 127.0.0.1
#   REDIS_PORT     default REDIS_HOST_PORT (environment, then .env), else 6379
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
env_file="$repo_root/.env"

log() { printf '%s\n' "$*" >&2; }
die() {
  printf 'new-test-db: %s\n' "$*" >&2
  exit 1
}

# Prints the value of KEY: the process environment wins, then the first KEY=value
# line of the repository .env (quotes stripped). Prints nothing when it is unset.
env_or_dotenv() {
  local key=$1 value
  value=${!key:-}
  if [ -z "$value" ] && [ -f "$env_file" ]; then
    value=$(grep -E "^${key}=" "$env_file" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)
  fi
  printf '%s' "$value"
}

# Prints the name of the Postgres container to use. PG_CONTAINER wins outright.
# Otherwise the choice must be unambiguous: with two running stacks (two
# worktrees, or the stand next to a local stack) taking the first match would
# silently provision the database in somebody else's cluster, so several
# candidates are an error.
resolve_pg_container() {
  local candidates count project
  if [ -n "${PG_CONTAINER:-}" ]; then
    printf '%s' "$PG_CONTAINER"
    return 0
  fi
  candidates=$(docker ps --format '{{.Names}}' 2>/dev/null | grep 'postgres' || true)
  project=$(env_or_dotenv COMPOSE_PROJECT_NAME)
  if [ -n "$project" ]; then
    candidates=$(printf '%s\n' "$candidates" | grep -E "^${project}[-_]postgres[-_]1$" || true)
  fi
  count=$(printf '%s\n' "$candidates" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    die "no running postgres container found (set PG_CONTAINER); is the local stack up?"
  fi
  if [ "$count" -gt 1 ]; then
    die "several postgres containers are running: $(printf '%s' "$candidates" | tr '\n' ' ')— set PG_CONTAINER (or COMPOSE_PROJECT_NAME) to pick one"
  fi
  printf '%s' "$candidates"
}

# Normalises a slug into the same valid, collision-resistant database
# identifier the provisioning path below computes, so a caller that wants to
# drop "its" database later (e.g. a --drop invocation) always names the same
# database this script would create or reuse for that slug.
dbname_for_slug() {
  local slug=$1 db_slug dbname hash prefix_len
  db_slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_')
  dbname="test_${db_slug}"
  # Postgres identifiers are truncated to NAMEDATALEN-1 (63 bytes). A long
  # slug (agent worktree/branch-derived names easily exceed this) would
  # otherwise get silently truncated by CREATE DATABASE while an existence
  # check still compared against the full, untruncated name — so a re-run
  # never found "its" database and CREATE DATABASE failed with "already
  # exists". Truncate here, deterministically; when truncation would
  # collide two different long slugs, mix in a short hash of the full name
  # so they still land on different databases.
  if [ ${#dbname} -gt 63 ]; then
    hash=$(printf '%s' "$dbname" | cksum | cut -d' ' -f1)
    hash=$(printf '%08x' "$hash")
    prefix_len=$((63 - 1 - ${#hash}))
    dbname="${dbname:0:$prefix_len}_${hash}"
  fi
  printf '%s' "$dbname"
}

if [ "${1:-}" = "--drop" ]; then
  slug=${2:-}
  [ -n "$slug" ] || die "usage: new-test-db.sh --drop <slug>"
  dbname=$(dbname_for_slug "$slug")
  container=$(resolve_pg_container)
  PG_USER=${PG_USER:-admin}
  log "→ dropping database ${dbname}"
  docker exec "$container" psql -U "$PG_USER" -d "$PG_USER" -q -c \
    "DROP DATABASE IF EXISTS \"${dbname}\" WITH (FORCE)" >/dev/null 2>&1 ||
    die "failed to drop database ${dbname}"
  log "✓ dropped ${dbname}"
  exit 0
fi

slug=${1:-}
[ -n "$slug" ] || die "usage: new-test-db.sh <slug>"
dbname=$(dbname_for_slug "$slug")

[ -f "$env_file" ] || die ".env not found at $env_file (needed for POSTGRES_PASSWORD)"

pw=$(env_or_dotenv POSTGRES_PASSWORD)
[ -n "$pw" ] || die "POSTGRES_PASSWORD is empty or missing in .env"
redis_pw=$(env_or_dotenv REDIS_PASSWORD)
[ -n "$redis_pw" ] || die "REDIS_PASSWORD is empty or missing in .env (TEST_REDIS_URL needs it)"

PG_USER=${PG_USER:-admin}
PG_HOST=${PG_HOST:-127.0.0.1}
PG_PORT=${PG_PORT:-$(env_or_dotenv POSTGRES_HOST_PORT)}
PG_PORT=${PG_PORT:-5432}
REDIS_HOST=${REDIS_HOST:-127.0.0.1}
REDIS_PORT=${REDIS_PORT:-$(env_or_dotenv REDIS_HOST_PORT)}
REDIS_PORT=${REDIS_PORT:-6379}
container=$(resolve_pg_container)

# Create the database if it does not already exist (idempotent).
exists=$(docker exec "$container" psql -U "$PG_USER" -d "$PG_USER" -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${dbname}'" 2>/dev/null | tr -d '[:space:]' || true)
if [ "$exists" = "1" ]; then
  log "→ database ${dbname} already exists — reusing it"
else
  log "→ creating database ${dbname}"
  docker exec "$container" psql -U "$PG_USER" -d "$PG_USER" -c "CREATE DATABASE \"${dbname}\"" >/dev/null 2>&1 ||
    die "failed to create database ${dbname}"
fi

url="postgres://${PG_USER}:${pw}@${PG_HOST}:${PG_PORT}/${dbname}"
# Logical databases 1-7 belong to the worker suites and 0 to the stack itself, so
# the name picks one of 8..15 (the API suite's range); cksum keeps it stable.
redis_db=$((8 + $(printf '%s' "$dbname" | cksum | cut -d' ' -f1) % 8))
redis_url="redis://:${redis_pw}@${REDIS_HOST}:${REDIS_PORT}/${redis_db}"

log "→ applying migrations (pnpm --filter @squad/db migrate)"
if DATABASE_URL="$url" pnpm --dir "$repo_root" --filter @squad/db migrate >&2; then
  log "→ migrations applied to ${dbname}"
else
  die "migrations failed against ${dbname}"
fi

# The ONLY stdout: eval-able exports. Same URL for both database variables so the
# migrate/worker path (DATABASE_URL) and the api integration harness
# (TEST_DATABASE_URL) can never diverge.
printf "export DATABASE_URL='%s'\n" "$url"
printf "export TEST_DATABASE_URL='%s'\n" "$url"
printf "export TEST_REDIS_URL='%s'\n" "$redis_url"
log "✓ ready: DATABASE_URL and TEST_DATABASE_URL both point at ${dbname}; TEST_REDIS_URL uses Redis db ${redis_db}"
