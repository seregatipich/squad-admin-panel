#!/usr/bin/env bash
# Local pre-push checklist. A push to `dev` deploys the tk104 development stand
# straight away, without tests, so this is the only check a change gets before
# it reaches the stand; the full suite runs in `ci` once the tip is promoted to
# `master`, and that run stays the authoritative gate. The default run is
# therefore narrow — about a minute with a warm turbo cache. Any failed item
# blocks the push; bypass in a genuine emergency with `git push --no-verify`.
#
# Wired in via lefthook (`pre-push` → command `checklist`), which runs it on
# every push, the dev→master promotion included. With nothing changed since
# origin/dev it only fetches, lints and scans.
#
# Default run, in order:
#   1. git fetch origin dev; offline, the local origin/dev ref is used as is.
#   2. biome check of the source directories.
#   3. gitleaks secret scan of origin/dev..HEAD (only if gitleaks is installed).
#   4. typecheck of the packages changed since origin/dev and their dependents.
#   5. tests of the changed packages only, not their dependents; in apps/api,
#      only the test files the diff touches. Suites whose tests read
#      DATABASE_URL or REDIS_URL run only when a database is available —
#      DATABASE_URL, or one provisioned for this worktree — and are skipped
#      with a warning otherwise.
#   6. pnpm test:scripts, only when scripts/ or .github/ changed (it needs the
#      database and Redis too).
#
# "Changed since origin/dev" is measured from the merge base, like
# `git diff origin/dev...`: step 1 moves origin/dev, and measured from its tip
# every commit that landed on dev after this branch forked would count as a
# change of this branch — one turbo global dependency among them marks every
# package changed.
#
# FULL=1 runs the old full gate instead: full typecheck, `biome check .`, the
# production build, gitleaks, test:scripts, test:cov and the mutation suite,
# failing when no database is available. Use it before a promotion you want to
# be confident about.
#
# Not run locally: the Go bridge (`apps/bridge` cannot build on macOS — run
# `go vet ./... && go test -race ./...` there on Linux) and Docker image
# builds.
#
# Turbo 2.9 already shares one cache between all worktrees of the clone (the
# main checkout's .turbo/cache), so packages another worktree built or
# typechecked are cache hits here; an exported TURBO_CACHE_DIR overrides it.
#
# Env knobs:
#   FULL=1                        run the full gate described above.
#   SKIP_BUILD=1                  with FULL=1, skip the production build.
#   PREPUSH_TURBO_CONCURRENCY=<n> parallel turbo tasks for package tests
#                                 (default 2).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

fail=0
declare -a passed=() failed=() skipped=()

run_step() { # <name> <cmd...>
  local name="$1"; shift
  printf '\n\033[1m=== [checklist] %s ===\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✓ %s\033[0m\n' "$name"; passed+=("$name")
  else
    printf '\033[31m✗ %s FAILED\033[0m\n' "$name"; failed+=("$name"); fail=1
  fi
}
skip_step() { printf '\n… [checklist] %s — skipped (%s)\n' "$1" "$2"; skipped+=("$1"); }
fail_step() { printf '\n\033[31m✗ [checklist] %s — %s\033[0m\n' "$1" "$2"; failed+=("$1"); fail=1; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }

scan_secrets() {
  if command -v gitleaks >/dev/null 2>&1; then
    run_step "gitleaks" gitleaks detect --config .gitleaks.toml --no-banner --redact --exit-code 1 --log-opts "origin/dev..HEAD"
  else
    skip_step "gitleaks" "not installed"
  fi
}

# Resolves a database for the DB-backed suites, at most once per run, and
# succeeds when one is available. An exported DATABASE_URL wins; otherwise the
# worktree's own database is provisioned through scripts/new-test-db.sh (Docker
# stack) or, failing that, created on a native Postgres at 127.0.0.1:5432.
db_resolved=0
ensure_db() {
  if [ "$db_resolved" = 0 ]; then
    db_resolved=1
    provision_db
  fi
  [ -n "${DATABASE_URL:-}" ]
}

provision_db() {
  if [ -n "${DATABASE_URL:-}" ]; then
    # The API harness reads TEST_DATABASE_URL; left unset it would not follow
    # the exported database.
    export TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
    return
  fi
  [ -f .env ] || return 0

  if docker ps >/dev/null 2>&1; then
    # One database per worktree, kept between pushes: a push applies only the
    # migrations that are new since the previous one, and parallel pushes from
    # different worktrees never share a database.
    local slug
    slug="prepush_$(basename "$PWD" | cut -c1-40)"
    echo "… provisioning this worktree's test DB via scripts/new-test-db.sh $slug"
    eval "$(bash scripts/new-test-db.sh "$slug" 2>/dev/null)" ||
      warn "scripts/new-test-db.sh $slug failed — run it by hand to see why"
  fi

  # scripts/new-test-db.sh drives `docker exec`, so the block above only fires
  # when the stack runs in Docker. A native Postgres on 127.0.0.1:5432 serves
  # equally well, so fall back to it rather than skipping the suites.
  if [ -z "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    _pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n1)"
    if [ -n "$_pw" ] && PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      _db="test_prepush_$$"
      echo "… provisioning an isolated test DB on the native Postgres ($_db)"
      if PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -q -c "CREATE DATABASE \"$_db\"" >/dev/null 2>&1; then
        export DATABASE_URL="postgres://admin:${_pw}@127.0.0.1:5432/${_db}"
        export TEST_DATABASE_URL="$DATABASE_URL"
        pnpm --filter @squad/db migrate >/dev/null 2>&1 || true
        trap 'PGPASSWORD="$_pw" psql -h 127.0.0.1 -U admin -d postgres -q -c "DROP DATABASE IF EXISTS \"$_db\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
      fi
    fi
  fi
}

no_db_hint() {
  warn "No database for the DB-backed suites. Start the local stack (docker compose up -d postgres redis)"
  warn "or export DATABASE_URL/TEST_DATABASE_URL (eval \"\$(bash scripts/new-test-db.sh <slug>)\"),"
  warn "then push again to run them; ci runs them after promotion either way."
}

# A package counts as DB-backed when its tests, test helpers or vitest config
# read a database or Redis URL; such suites fail or skip without one.
DB_ENV_PATTERN='(DATABASE|REDIS)_URL'
is_db_backed() { # <package dir>
  grep -rqsE "$DB_ENV_PATTERN" "$1/test" "$1/tests" "$1"/vitest.config.* ||
    grep -rqsE --include='*.test.*' "$DB_ENV_PATTERN" "$1/src"
}

run_changed() {
  local base listing changed_files name dir file
  local -a plain=() db_backed=() api_tests=() filters=()
  local api_changed=0 scripts_changed=0 db_ready=0

  if ! base="$(git merge-base origin/dev HEAD 2>/dev/null)"; then
    fail_step "changes since origin/dev" "no merge base with origin/dev; run: git fetch origin dev"
    return
  fi

  if ! listing="$(pnpm -s turbo ls --filter="[$base]" --output=json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const p of JSON.parse(s).packages.items)console.log(`${p.name}\t${p.path}`)})')"; then
    fail_step "changes since origin/dev" "turbo ls --filter=[$base] failed"
    return
  fi
  changed_files="$(git diff --name-only --diff-filter=d "$base"; git ls-files --others --exclude-standard)"

  if [ -z "$listing" ]; then
    skip_step "typecheck" "no package changed since origin/dev"
    skip_step "package tests" "no package changed since origin/dev"
  else
    run_step "typecheck (changed since origin/dev, with dependents)" \
      pnpm turbo run typecheck --filter="...[$base]"

    while IFS=$'\t' read -r name dir; do
      [ -n "$name" ] || continue
      if [ "$name" = "@squad/api" ]; then
        api_changed=1
      elif is_db_backed "$dir"; then
        db_backed+=("$name")
      else
        plain+=("$name")
      fi
    done <<<"$listing"
  fi

  while IFS= read -r file; do
    case "$file" in
      apps/api/*.test.ts | apps/api/*.test.tsx) api_tests+=("${file#apps/api/}") ;;
      scripts/* | .github/*) scripts_changed=1 ;;
    esac
  done <<<"$changed_files"

  if [ ${#db_backed[@]} -gt 0 ] || [ ${#api_tests[@]} -gt 0 ] || [ "$scripts_changed" = 1 ]; then
    if ensure_db; then db_ready=1; else no_db_hint; fi
  fi

  for name in ${plain[@]+"${plain[@]}"}; do filters+=("--filter=$name"); done
  if [ ${#db_backed[@]} -gt 0 ]; then
    if [ "$db_ready" = 1 ]; then
      for name in "${db_backed[@]}"; do filters+=("--filter=$name"); done
    else
      skip_step "DB-backed package tests" "no database: ${db_backed[*]}"
    fi
  fi
  if [ ${#filters[@]} -gt 0 ]; then
    run_step "package tests (changed since origin/dev)" pnpm turbo run test \
      --concurrency="${PREPUSH_TURBO_CONCURRENCY:-2}" "${filters[@]}"
  elif [ -n "$listing" ] && [ ${#db_backed[@]} -eq 0 ]; then
    skip_step "package tests" "no changed package besides @squad/api"
  fi

  if [ ${#api_tests[@]} -gt 0 ]; then
    if [ "$db_ready" = 1 ]; then
      run_step "api tests (changed test files)" \
        pnpm --filter @squad/api exec vitest run --passWithNoTests "${api_tests[@]}"
    else
      skip_step "api tests" "no database: ${api_tests[*]}"
    fi
  elif [ "$api_changed" = 1 ]; then
    skip_step "api tests" "no api test file changed; ci runs the suite"
  fi

  if [ "$scripts_changed" = 0 ]; then
    skip_step "operations and verification script tests" "scripts/ and .github/ unchanged"
  elif [ "$db_ready" = 1 ]; then
    run_step "operations and verification script tests" pnpm test:scripts
  else
    skip_step "operations and verification script tests" "no database"
  fi
}

run_full() {
  run_step "typecheck" pnpm turbo run typecheck
  run_step "biome" pnpm exec biome check .
  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    skip_step "build" "SKIP_BUILD=1"
  else
    run_step "build" pnpm turbo run build
  fi
  scan_secrets
  if ensure_db; then
    run_step "operations and verification script tests" pnpm test:scripts
    run_step "tests (full coverage)" pnpm test:cov
  else
    fail_step "tests" "no DATABASE_URL and could not auto-provision"
    echo "   Start the local stack (docker compose up -d postgres redis), run a native Postgres"
    echo "   on 127.0.0.1:5432 with the .env password, and/or set DATABASE_URL,"
    echo "   or run: eval \"\$(bash scripts/new-test-db.sh <slug>)\"  then push again."
    echo "   (Bypass in an emergency with: git push --no-verify)"
  fi
  run_step "mutation tests (full)" pnpm turbo run test:mutation
}

printf '\033[1m=== [checklist] fetch origin dev ===\033[0m\n'
git fetch -q origin dev || warn "could not fetch origin dev — comparing against the local origin/dev ref"

if [ "${FULL:-0}" = "1" ]; then
  run_full
else
  run_step "biome" pnpm exec biome check apps packages scripts docker/rnsquadjs
  scan_secrets
  run_changed
fi

printf '\n\033[1m=== pre-push checklist summary ===\033[0m\n'
[ ${#passed[@]}  -gt 0 ] && printf '  passed:  %s\n' "${passed[*]}"
[ ${#skipped[@]} -gt 0 ] && printf '  skipped: %s\n' "${skipped[*]}"
[ ${#failed[@]}  -gt 0 ] && printf '  \033[31mfailed:  %s\033[0m\n' "${failed[*]}"

if [ "$fail" = "0" ]; then
  printf '\033[32m✓ pre-push checklist passed\033[0m\n'
else
  printf '\033[31m✗ pre-push checklist FAILED — fix the items above, or bypass with --no-verify\033[0m\n'
fi
exit "$fail"
