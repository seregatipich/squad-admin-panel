#!/usr/bin/env bash
# verify.sh — fast local completion gate: typecheck + lint + DB-backed tests.
#
# Narrower than scripts/pre-push-checklist.sh (no build, no gitleaks — those
# aren't part of "tests pass, lint is clean"): this exists so a bare `npm
# test` isn't run without a database. Without this script, a generic runner
# invoking `npm test` in a fresh shell has no DATABASE_URL and every
# DB-backed suite (apps/api, most workers) fails immediately — a false
# negative, not a real regression; scripts/pre-push-checklist.sh and the `ci`
# workflow remain the authoritative gates.
#
# DB provisioning, in order: an already-exported DATABASE_URL; a
# gitignored .env.local at repo root (DATABASE_URL=... / REDIS_URL=...,
# for a long-lived local stack — see .env.local.example); then the same
# auto-provisioning scripts/pre-push-checklist.sh uses (scripts/new-test-db.sh
# over Docker, or a native Postgres on 127.0.0.1:5432); else fail with next
# steps.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

fail=0
declare -a passed=() failed=()

run_step() { # <name> <cmd...>
  local name="$1"; shift
  printf '\n\033[1m=== [verify] %s ===\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✓ %s\033[0m\n' "$name"; passed+=("$name")
  else
    printf '\033[31m✗ %s FAILED\033[0m\n' "$name"; failed+=("$name"); fail=1
  fi
}

run_step "typecheck" pnpm turbo run typecheck
run_step "biome" pnpm exec biome check .

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ] && docker ps >/dev/null 2>&1; then
  echo "… provisioning an isolated test DB via scripts/new-test-db.sh"
  eval "$(bash scripts/new-test-db.sh verify 2>/dev/null)" || true
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ] && command -v psql >/dev/null 2>&1; then
  _pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n1)"
  if [ -n "$_pw" ] && PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    _db="test_verify_$$"
    echo "… provisioning an isolated test DB on the native Postgres ($_db)"
    if PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -q -c "CREATE DATABASE \"$_db\"" >/dev/null 2>&1; then
      export DATABASE_URL="postgres://admin:${_pw}@127.0.0.1:5432/${_db}"
      export TEST_DATABASE_URL="$DATABASE_URL"
      pnpm --filter @squad/db migrate >/dev/null 2>&1 || true
      trap 'PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -q -c "DROP DATABASE IF EXISTS \"$_db\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
    fi
  fi
fi

if [ -n "${DATABASE_URL:-}" ]; then
  export TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
  run_step "tests (affected since origin/dev)" pnpm turbo run test --filter='...[origin/dev]'
else
  printf '\n\033[31m✗ [verify] tests — no DATABASE_URL and could not auto-provision\033[0m\n'
  echo "   Start the local stack (docker compose up -d postgres redis), run a native Postgres"
  echo "   on 127.0.0.1:5432 with the .env password, and/or set DATABASE_URL,"
  echo "   or run: eval \"\$(bash scripts/new-test-db.sh <slug>)\"  then rerun."
  failed+=("tests"); fail=1
fi

printf '\n\033[1m=== verify summary ===\033[0m\n'
[ ${#passed[@]} -gt 0 ] && printf '  passed:  %s\n' "${passed[*]}"
[ ${#failed[@]} -gt 0 ] && printf '  \033[31mfailed:  %s\033[0m\n' "${failed[*]}"

if [ "$fail" = "0" ]; then
  printf '\033[32m✓ verify passed\033[0m\n'
else
  printf '\033[31m✗ verify FAILED\033[0m\n'
fi
exit "$fail"
