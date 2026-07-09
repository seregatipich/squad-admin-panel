#!/usr/bin/env bash
# Local pre-push test checklist — the source of truth now that cloud CI is
# disabled (self-hosted runners retired). Runs an ordered checklist of the same
# gates the `ci` workflow used to run; ANY failed item blocks the push.
#
# Wired in via lefthook (`pre-push` → command `checklist`). Because it is a
# lefthook *command* (not a script) it is skipped when the current branch has no
# unpushed diff — e.g. the dev→master promotion push — so promotions are not
# re-tested. Bypass in a genuine emergency with `git push --no-verify`.
#
# Scope of what runs locally:
#   - typecheck, biome (lint/format), build, secret scan, and the JS/TS test
#     suite are run here.
#   - The Go bridge (`apps/bridge`) and Docker image builds are NOT run locally
#     (the Go bridge cannot build on macOS; Docker builds are heavy) — run
#     `go vet ./... && go test -race ./...` inside `apps/bridge` on Linux, and
#     `docker build` manually, when touching those.
#
# Env knobs:
#   FULL=1        run the full coverage suite (`pnpm test:cov`) instead of the
#                 packages affected since origin/dev.
#   SKIP_BUILD=1  skip the production build step (faster; typecheck still runs).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

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

# 1. Types
run_step "typecheck" pnpm turbo run typecheck

# 2. Lint / format (whole repo, mirroring the CI biome step)
run_step "biome" pnpm exec biome check .

# 3. Production build
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  skip_step "build" "SKIP_BUILD=1"
else
  run_step "build" pnpm turbo run build
fi

# 4. Secret scan (best-effort — only if gitleaks is installed)
if command -v gitleaks >/dev/null 2>&1; then
  run_step "gitleaks" gitleaks detect --config .gitleaks.toml --no-banner --redact --exit-code 1
else
  skip_step "gitleaks" "not installed"
fi

# 5. Tests (DB-backed). Auto-provision an isolated migrated DB when possible so
#    the gate is real rather than skipped.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ] && docker ps >/dev/null 2>&1; then
  echo "… provisioning an isolated test DB via scripts/new-test-db.sh"
  eval "$(bash scripts/new-test-db.sh prepush 2>/dev/null)" || true
fi

if [ -n "${DATABASE_URL:-}" ]; then
  if [ "${FULL:-0}" = "1" ]; then
    run_step "tests (full coverage)" pnpm test:cov
  else
    run_step "tests (affected since origin/dev)" pnpm turbo run test --filter='...[origin/dev]'
  fi
else
  printf '\n\033[31m✗ [checklist] tests — no DATABASE_URL and could not auto-provision\033[0m\n'
  echo "   Start the local stack (docker compose up -d postgres redis) and/or set DATABASE_URL,"
  echo "   or run: eval \"\$(bash scripts/new-test-db.sh <slug>)\"  then push again."
  echo "   (Bypass in an emergency with: git push --no-verify)"
  failed+=("tests"); fail=1
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
