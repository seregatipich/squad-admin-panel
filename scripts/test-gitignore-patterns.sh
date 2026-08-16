#!/usr/bin/env bash
# test-gitignore-patterns.sh — fail if the Stryker mutation-report ignore
# pattern in .gitignore stops matching per-package output directories.
#
# `.gitignore` ignores Stryker's HTML report directory with a pattern that
# must stay un-anchored (`**/reports/mutation/`) so it matches at any depth —
# `packages/shared-config/reports/mutation/`, `apps/api/reports/mutation/`,
# and so on — not only a top-level `reports/mutation/`. A pattern containing
# a `/` anywhere but the end anchors to the directory holding the `.gitignore`
# file (the repo root), so a regression here (e.g. dropping the `**/` prefix)
# silently stops ignoring every per-package report dir and leaves
# `scripts/pre-push-checklist.sh` / `scripts/verify-done.sh` seeing a dirty
# working tree after `pnpm turbo run test:mutation` (#260).
#
# Exit 0 = the pattern still ignores per-package and root report dirs without
# ignoring real source files; exit 1 = at least one check failed.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=()
checked=0
created=()

cleanup() {
  for path in "${created[@]}"; do
    rm -f "$path"
  done
}
trap cleanup EXIT

check_ignored() {
  local path=$1
  checked=$((checked + 1))
  mkdir -p "$(dirname "$path")"
  touch "$path"
  created+=("$path")
  if ! git check-ignore -q "$path"; then
    failures+=("expected '$path' to be ignored, but it is not")
  fi
}

check_not_ignored() {
  local path=$1
  checked=$((checked + 1))
  if git check-ignore -q "$path"; then
    failures+=("expected '$path' to NOT be ignored, but it is")
  fi
}

check_ignored "packages/shared-config/reports/mutation/mutation.html"
check_ignored "apps/api/reports/mutation/index.html"
check_ignored "reports/mutation/mutation.html"
check_not_ignored "packages/shared-config/src/index.ts"

if [ ${#failures[@]} -gt 0 ]; then
  echo "test-gitignore-patterns: FAIL — ${#failures[@]} of $checked check(s) failed:" >&2
  for f in "${failures[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "The Stryker report pattern in .gitignore must stay '**/reports/mutation/'" >&2
  echo "(un-anchored) so it matches at any depth, not just the repo root." >&2
  exit 1
fi

echo "test-gitignore-patterns: OK — all $checked gitignore check(s) passed"
