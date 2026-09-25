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

# --- gh stub: canned `gh run list --json ...` output per workflow ---------
# GH_DEPLOY_MODE answers for deploy-tk104.yml (runs on dev), GH_CI_MODE for
# ci.yml (runs on master). GH_STUB_SHA is the tip under test; the `docs` deploy
# mode reports a green deploy of GH_STUB_OLD_SHA only.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'EOF'
#!/bin/sh
workflow=""
while [ $# -gt 0 ]; do
  [ "$1" = "--workflow" ] && workflow=$2
  shift
done
case "$workflow" in
deploy-tk104.yml) mode=${GH_DEPLOY_MODE:-green} ;;
*) mode=${GH_CI_MODE:-green} ;;
esac
case "$mode" in
green)   printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":111}]\n' "$GH_STUB_SHA" ;;
red)     printf '[{"headSha":"%s","status":"completed","conclusion":"failure","databaseId":222}]\n' "$GH_STUB_SHA" ;;
running) printf '[{"headSha":"%s","status":"in_progress","conclusion":null,"databaseId":333}]\n' "$GH_STUB_SHA" ;;
stale)   printf '[{"headSha":"0000000000000000000000000000000000000000","status":"completed","conclusion":"success","databaseId":444}]\n' ;;
docs)    printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":555}]\n' "$GH_STUB_OLD_SHA" ;;
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
git add scripts && git commit -q -m "add verifier" && git push -q origin dev dev:master

export GH_STUB_SHA=$(git rev-parse origin/dev)

assert pass "clean tree, dev pushed, deployed, promoted, master CI green at tip"

GH_DEPLOY_MODE=red assert fail "dev stand deploy concluded failure"
GH_DEPLOY_MODE=running assert fail "dev stand deploy still in progress"
GH_DEPLOY_MODE=empty assert fail "no deploy run for the current tip or any ancestor"
GH_DEPLOY_MODE=stale assert fail "green deploy exists only for an unrelated SHA"

GH_CI_MODE=red assert fail "master CI run concluded failure"
GH_CI_MODE=running assert fail "master CI run still in progress"
GH_CI_MODE=stale assert fail "green master CI run exists only for an older SHA"
GH_CI_MODE=empty assert fail "no master CI run for the current tip"

# A tip that only changes docs has no deploy run of its own (deploy-tk104.yml
# ignores such pushes); the ancestor's green deploy covers it.
deployed=$(git rev-parse HEAD)
mkdir -p docs && echo guide >docs/guide.md && echo notes >NOTES.md
git add docs NOTES.md && git commit -q -m "docs only" && git push -q origin dev dev:master
GH_STUB_SHA=$(git rev-parse origin/dev) GH_STUB_OLD_SHA=$deployed GH_DEPLOY_MODE=docs \
  assert pass "docs-only tip covered by the last green deploy of an ancestor"
echo code >code.ts && git add code.ts && git commit -q -m "code" && git push -q origin dev dev:master
GH_STUB_SHA=$(git rev-parse origin/dev) GH_STUB_OLD_SHA=$deployed GH_DEPLOY_MODE=docs \
  assert fail "tip changes deployable files but only an ancestor was deployed"

# Pushed to dev but not promoted: master still points at the previous tip.
echo more >>code.ts && git add code.ts && git commit -q -m "more code" && git push -q origin dev
export GH_STUB_SHA=$(git rev-parse origin/dev)
assert fail "dev tip not promoted to master"
git push -q origin dev:master
git fetch -q origin

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

# On a pushed feature branch with a clean tree, --feature must PASS (no deploy or CI needed).
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
