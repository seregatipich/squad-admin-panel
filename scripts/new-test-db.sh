#!/usr/bin/env bash
# new-test-db.sh — provision an isolated, migrated test database for one agent/wave.
#
# Kills the setup footguns that repeatedly cost parallel agents time:
#   - the local Postgres password is the POSTGRES_PASSWORD token in .env, NOT "admin";
#   - from the host, Postgres is reachable at 127.0.0.1:5432 (the .env DATABASE_URL
#     uses the docker-internal host "postgres", which does not resolve on the host);
#   - the API integration harness reads TEST_DATABASE_URL (reusePublicSchema →
#     HOST_DB_URL), while workers/migrate read DATABASE_URL — so BOTH must point at
#     the same isolated DB or tests silently hit the shared `admin` database.
#
# Usage:
#   eval "$(bash scripts/new-test-db.sh <slug>)"     # provision + export both vars
#   bash scripts/new-test-db.sh <slug>               # just print the export lines
#
# Progress goes to stderr; ONLY the two `export …` lines go to stdout, so the
# command is safe to `eval`. Idempotent: re-running for the same slug reuses the DB.
#
# Env overrides: PG_CONTAINER (default: the running squad-admin-panel postgres),
# PG_HOST (default 127.0.0.1), PG_PORT (default 5432), PG_USER (default admin).
set -eu

log() { printf '%s\n' "$*" >&2; }
die() {
  printf 'new-test-db: %s\n' "$*" >&2
  exit 1
}

slug=${1:-}
[ -n "$slug" ] || die "usage: new-test-db.sh <slug>"
# Normalise the slug into a valid, collision-resistant database identifier.
db_slug=$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_')
dbname="test_${db_slug}"

repo_root=$(cd "$(dirname "$0")/.." && pwd)
env_file="$repo_root/.env"
[ -f "$env_file" ] || die ".env not found at $env_file (needed for POSTGRES_PASSWORD)"

pw=$(grep -E '^POSTGRES_PASSWORD=' "$env_file" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
[ -n "$pw" ] || die "POSTGRES_PASSWORD is empty or missing in .env"

PG_USER=${PG_USER:-admin}
PG_HOST=${PG_HOST:-127.0.0.1}
PG_PORT=${PG_PORT:-5432}
container=${PG_CONTAINER:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 'postgres' || true)}
[ -n "$container" ] || die "no running postgres container found (set PG_CONTAINER); is the local stack up?"

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

log "→ applying migrations (pnpm --filter @squad/db migrate)"
if DATABASE_URL="$url" pnpm --dir "$repo_root" --filter @squad/db migrate >&2; then
  log "→ migrations applied to ${dbname}"
else
  die "migrations failed against ${dbname}"
fi

# The ONLY stdout: eval-able exports. Same URL for both variables so the
# migrate/worker path (DATABASE_URL) and the api integration harness
# (TEST_DATABASE_URL) can never diverge.
printf "export DATABASE_URL='%s'\n" "$url"
printf "export TEST_DATABASE_URL='%s'\n" "$url"
log "✓ ready: DATABASE_URL and TEST_DATABASE_URL both point at ${dbname}"
