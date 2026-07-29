#!/usr/bin/env bash
# test-pre-push-checklist.sh — regression suite for the gitleaks step in
# scripts/pre-push-checklist.sh.
#
# Builds a throwaway git repo where a secret-shaped value lives in history
# that is already merged into dev (outside the range a later branch would
# push), and asserts the checklist's real, extracted `gitleaks detect ...`
# invocation ignores that already-merged historical leak but still catches a
# new one introduced within the pushed range. Run locally or in CI:
# `bash scripts/test-pre-push-checklist.sh`. Exits non-zero on any failure.

set -uo pipefail

# Fixture repos must not trigger the developer's own git hooks.
export LEFTHOOK=0

# This test's own subject is a gitleaks invocation, so unlike the production
# checklist's best-effort skip, it must not silently no-op when gitleaks is
# missing — that would prove nothing.
command -v gitleaks >/dev/null 2>&1 || {
  echo "test-pre-push-checklist: gitleaks is not installed / not on PATH" >&2
  exit 1
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CHECKLIST="$REPO_ROOT/scripts/pre-push-checklist.sh"

# Extract the real, current production command rather than hand-copying it,
# so this test always exercises what actually ships, not a duplicate that can
# drift out of sync.
gitleaks_cmd=$(grep -o 'gitleaks detect .*' "$CHECKLIST")
if [ -z "$gitleaks_cmd" ]; then
  echo "test-pre-push-checklist: could not extract a 'gitleaks detect ...' invocation from $CHECKLIST" >&2
  exit 1
fi

git_q() { git "$@" >/dev/null 2>&1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/pre-push-checklist-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

# --- fixture repo -------------------------------------------------------
# master --- dev (ahead of master) --- feature/old-secret (merged into dev,
# carries a leaked-looking AWS key) --- feature/clean (branched off dev AFTER
# that merge, no secret of its own). Bare origin with dev + feature/clean
# pushed, so origin/dev resolves locally without a separate fetch.
REPO="$TMP/repo"
ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
git init -q -b master "$REPO"
cd "$REPO"
git config user.email guard-test@example.com
git config user.name "guard test"
echo one >file && git add file && git_q commit -m "root"

git_q branch dev
git_q switch dev
echo two >>file && git add file && git_q commit -m "dev work"

git_q switch -c feature/old-secret
# Split so this test script's own committed text never contains the
# contiguous AWS-key-shaped string — otherwise gitleaks would flag this
# fixture-building line itself, in every future scan of this repo's history.
# The concatenation still writes the intact fixture value to secret.txt.
old_secret_p1="AKIA"
old_secret_p2="ABCDEFGHIJKLMNOP"
echo "AWS_KEY=${old_secret_p1}${old_secret_p2}" >secret.txt
git add secret.txt
git_q commit -m "add secret.txt"

git_q switch dev
git_q merge --no-ff feature/old-secret -m "merge feature/old-secret"

git_q switch -c feature/clean
echo "clean work" >>file && git add file && git_q commit -m "clean work"

git remote add origin "$ORIGIN"
git_q push origin dev feature/clean

# The extracted command's --config flag is relative to cwd.
cp "$REPO_ROOT/.gitleaks.toml" "$REPO/.gitleaks.toml"

# --- Test A: scoped push excludes an already-merged historical secret -------
out=$(eval "$gitleaks_cmd" 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: scoped push excludes an already-merged historical secret"
  echo "      expected rc=0 got rc=$rc"
  echo "      command: $gitleaks_cmd"
  echo "      output:"
  echo "$out"
fi

# --- Test B: scoped push still catches a secret introduced within range -----
# Same split-literal rationale as feature/old-secret's secret.txt above.
new_secret_p1="AKIA"
new_secret_p2="ZYXWVUTSRQPONMLK"
echo "AWS_KEY=${new_secret_p1}${new_secret_p2}" >secret2.txt
git add secret2.txt
git_q commit -m "add secret2.txt"

out=$(eval "$gitleaks_cmd" 2>&1)
rc=$?
if [ "$rc" -eq 1 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: scoped push still catches a secret introduced within the pushed range"
  echo "      expected rc=1 got rc=$rc"
  echo "      command: $gitleaks_cmd"
  echo "      output:"
  echo "$out"
fi

echo
echo "test-pre-push-checklist: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
