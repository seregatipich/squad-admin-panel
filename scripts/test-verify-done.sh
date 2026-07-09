#!/usr/bin/env bash
# test-verify-done.sh — test suite for scripts/verify-done.sh.
#
# Builds a throwaway repo (with a file:// origin), wires the local test gate
# (pre-push-checklist.sh + a lefthook.yml that invokes it), then asserts the
# verifier's verdict for every mechanical completion state. Run:
# `bash scripts/test-verify-done.sh`.

set -u

export LEFTHOOK=0

SRC=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/verify-done-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

# assert <expected: pass|fail> <description>  (runs verify-done in $REPO)
assert() {
  local expected=$1 desc=$2 out rc got
  out=$(cd "$REPO" && "$REPO/scripts/verify-done.sh" 2>&1)
  rc=$?
  got=pass
  [ $rc -ne 0 ] && got=fail
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got (rc=$rc)"
    printf '%s\n' "$out" | sed 's/^/      | /'
  fi
}

# assert_feature <expected: pass|fail> <description>  (runs verify-done --feature in $REPO)
assert_feature() {
  local expected=$1 desc=$2 out rc got
  out=$(cd "$REPO" && "$REPO/scripts/verify-done.sh" --feature 2>&1)
  rc=$?
  got=pass
  [ $rc -ne 0 ] && got=fail
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got (rc=$rc)"
    printf '%s\n' "$out" | sed 's/^/      | /'
  fi
}

# --- fixture: repo on dev, fully pushed to a file origin ---------------------
ORIGIN="$TMP/origin.git"
REPO="$TMP/repo"
git init -q --bare "$ORIGIN"
git init -q -b master "$REPO"
cd "$REPO"
git config user.email verify-test@example.com
git config user.name "verify test"
echo one >file && git add file && git commit -q -m root
git branch dev
git remote add origin "$ORIGIN"
git push -q origin master dev
git switch -q dev
mkdir -p scripts
cp "$SRC/verify-done.sh" "$SRC/git-guard.sh" "$SRC/pre-push-checklist.sh" scripts/
chmod +x scripts/pre-push-checklist.sh
printf 'pre-push:\n  commands:\n    checklist:\n      run: bash scripts/pre-push-checklist.sh\n' >lefthook.yml
git add scripts lefthook.yml && git commit -q -m "add verifier + local test gate" && git push -q origin dev

# --- cases --------------------------------------------------------------------
assert pass "clean tree, dev pushed, local test gate wired"

# Local test gate missing -> FAIL (tree stays clean+pushed so check #4 is reached).
git rm -q scripts/pre-push-checklist.sh && git commit -q -m "drop checklist" && git push -q origin dev
assert fail "local test gate missing (checklist script absent)"
cp "$SRC/pre-push-checklist.sh" scripts/ && chmod +x scripts/pre-push-checklist.sh
git add scripts/pre-push-checklist.sh && git commit -q -m "restore checklist" && git push -q origin dev

# Gate present but not wired into lefthook -> FAIL.
printf 'pre-push:\n  commands: {}\n' >lefthook.yml
git add lefthook.yml && git commit -q -m "unwire checklist" && git push -q origin dev
assert fail "local test gate not wired into lefthook pre-push"
printf 'pre-push:\n  commands:\n    checklist:\n      run: bash scripts/pre-push-checklist.sh\n' >lefthook.yml
git add lefthook.yml && git commit -q -m "rewire checklist" && git push -q origin dev

echo dirty >dirty.txt
assert fail "uncommitted changes in the working tree"
rm dirty.txt

git switch -qc feature/wip
assert fail "still on a work branch, not dev"
git switch -q dev
git branch -qD feature/wip

echo two >>file && git add file && git commit -q -m "unpushed"
assert fail "dev ahead of origin/dev (unpushed commit)"
git reset -q --hard origin/dev

git branch -q main
assert fail "doctor warning: a main branch exists"
git branch -qD main

assert pass "back to a fully done state"

# --- --feature (parallel-wave handoff) mode --------------------------------
# On dev, --feature must FAIL (dev is not a work branch).
assert_feature fail "feature mode rejects being on dev"

# On a pushed feature branch with a clean tree, --feature must PASS (no CI needed).
git switch -qc feature/wave-task
echo work >feat.txt && git add feat.txt && git commit -q -m "wave work"
git push -q origin feature/wave-task
assert_feature pass "feature branch implemented, committed, pushed"

# Uncommitted changes -> FAIL.
echo more >>feat.txt
assert_feature fail "feature branch with a dirty working tree"
git checkout -q -- feat.txt

# Local commits not pushed -> FAIL.
echo more >>feat.txt && git add feat.txt && git commit -q -m "unpushed wave work"
assert_feature fail "feature branch ahead of its origin (unpushed)"
git push -q origin feature/wave-task
assert_feature pass "feature branch pushed again -> ready"

git switch -q dev
git branch -qD feature/wave-task

echo
echo "verify-done tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
