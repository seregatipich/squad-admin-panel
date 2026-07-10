#!/usr/bin/env bash
# test-verify-done.sh — test suite for scripts/verify-done.sh.
#
# Builds a throwaway repo (with a file:// origin) and stubs `gh` via PATH to
# emit canned CI-run JSON, then asserts the verifier's verdict for every
# mechanical completion state. Run: `bash scripts/test-verify-done.sh`.

set -u

export LEFTHOOK=0

SRC=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/verify-done-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

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

# --- gh stub: canned `gh run list --json ...` output, mode via GH_STUB_MODE --
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'EOF'
#!/bin/sh
case "${GH_STUB_MODE:-green}" in
green)   printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":111}]\n' "$GH_STUB_SHA" ;;
red)     printf '[{"headSha":"%s","status":"completed","conclusion":"failure","databaseId":222}]\n' "$GH_STUB_SHA" ;;
running) printf '[{"headSha":"%s","status":"in_progress","conclusion":null,"databaseId":333}]\n' "$GH_STUB_SHA" ;;
stale)   printf '[{"headSha":"0000000000000000000000000000000000000000","status":"completed","conclusion":"success","databaseId":444}]\n' ;;
empty)   printf '[]\n' ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

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
cp "$SRC/verify-done.sh" "$SRC/git-guard.sh" scripts/
git add scripts && git commit -q -m "add verifier" && git push -q origin dev

export GH_STUB_SHA=$(git rev-parse origin/dev)

GH_STUB_MODE=green assert pass "clean tree, dev pushed, CI green at tip"

GH_STUB_MODE=red assert fail "CI run concluded failure"
GH_STUB_MODE=running assert fail "CI run still in progress"
GH_STUB_MODE=stale assert fail "green CI run exists only for an older SHA"
GH_STUB_MODE=empty assert fail "no CI run for the current tip"

echo dirty >dirty.txt
GH_STUB_MODE=green assert fail "uncommitted changes in the working tree"
rm dirty.txt

git switch -qc feature/wip
GH_STUB_MODE=green assert fail "still on a work branch, not dev"
git switch -q dev
git branch -qD feature/wip

echo two >>file && git add file && git commit -q -m "unpushed"
GH_STUB_MODE=green assert fail "dev ahead of origin/dev (unpushed commit)"
git reset -q --hard origin/dev

git branch -q main
GH_STUB_MODE=green GH_STUB_SHA=$(git rev-parse origin/dev) assert fail "doctor warning: a main branch exists"
git branch -qD main

GH_STUB_MODE=green assert pass "back to a fully done state"

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
