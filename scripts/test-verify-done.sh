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

# Like assert, but runs `verify-done.sh --wait <seconds>` with a 1 s poll.
assert_wait() {
  local expected=$1 desc=$2 seconds=$3 out rc got
  rm -rf "$GH_FLIP_DIR" && mkdir -p "$GH_FLIP_DIR"
  out=$(cd "$REPO" && VERIFY_DONE_POLL_SECS=1 "$REPO/scripts/verify-done.sh" --wait "$seconds" 2>&1)
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

# Like assert_feature, but passes an explicit branch argument: `--feature <branch>`.
assert_feature_arg() {
  local expected=$1 desc=$2 branch_arg=$3 out rc got
  out=$(cd "$REPO" && "$REPO/scripts/verify-done.sh" --feature "$branch_arg" 2>&1)
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
# GH_DEPLOY_MODE answers for deploy.yml (runs on dev), GH_CI_MODE for
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
deploy.yml) mode=${GH_DEPLOY_MODE:-green} ;;
*) mode=${GH_CI_MODE:-green} ;;
esac
case "$mode" in
green)   printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":111}]\n' "$GH_STUB_SHA" ;;
red)     printf '[{"headSha":"%s","status":"completed","conclusion":"failure","databaseId":222}]\n' "$GH_STUB_SHA" ;;
flip)    # in progress on the first poll of this workflow, green afterwards
  n=$(cat "$GH_FLIP_DIR/$workflow" 2>/dev/null || echo 0)
  echo $((n + 1)) >"$GH_FLIP_DIR/$workflow"
  if [ "$n" -eq 0 ]; then
    printf '[{"headSha":"%s","status":"in_progress","conclusion":null,"databaseId":666}]\n' "$GH_STUB_SHA"
  else
    printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":666}]\n' "$GH_STUB_SHA"
  fi ;;
running) printf '[{"headSha":"%s","status":"in_progress","conclusion":null,"databaseId":333}]\n' "$GH_STUB_SHA" ;;
stale)   printf '[{"headSha":"0000000000000000000000000000000000000000","status":"completed","conclusion":"success","databaseId":444}]\n' ;;
docs)    printf '[{"headSha":"%s","status":"completed","conclusion":"success","databaseId":555}]\n' "$GH_STUB_OLD_SHA" ;;
empty)   printf '[]\n' ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
export GH_FLIP_DIR="$TMP/flip"

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

# A tip that only changes docs has no deploy run of its own (deploy.yml
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

# `dev` is normally checked out in another worktree, which leaves this one on a
# detached HEAD. At the origin/dev tip that is the integration state; anywhere
# else it is not.
git switch -q --detach origin/dev
assert pass "detached HEAD at the origin/dev tip"
git switch -q --detach origin/dev~1
assert fail "detached HEAD behind the origin/dev tip"
echo detached >detached.txt && git add detached.txt && git commit -q -m "detached work"
assert fail "detached HEAD with a commit that is not on origin/dev"
git switch -q dev
git reset -q --hard origin/dev

git branch -q main
assert fail "doctor warning: a main branch exists"
git branch -qD main

# A broken/crashing git-guard.sh must FAIL, not silently read as clean just
# because its output happens to contain no "WARN" (#76 / #1227). Committed
# (not left dirty) so the working-tree-clean check doesn't mask the doctor
# check this is meant to isolate.
printf '#!/bin/sh\nexit 7\n' >scripts/git-guard.sh
git add scripts/git-guard.sh && git commit -q -m "break git-guard for test"
git push -q origin dev dev:master
GH_STUB_SHA=$(git rev-parse origin/dev) assert fail "git-guard.sh doctor crashing must not read as a silent PASS"
git revert --no-edit HEAD >/dev/null
git push -q origin dev dev:master
export GH_STUB_SHA=$(git rev-parse origin/dev)

assert pass "back to a fully done state"

# --wait polls runs that are still in progress instead of failing on them.
GH_DEPLOY_MODE=flip GH_CI_MODE=flip assert_wait pass "--wait: deploy and ci finish while polling" 10
GH_DEPLOY_MODE=running GH_CI_MODE=green assert_wait fail "--wait: a deploy that never finishes times out" 2
GH_DEPLOY_MODE=green GH_CI_MODE=running assert_wait fail "--wait: a ci run that never finishes times out" 2
GH_DEPLOY_MODE=green GH_CI_MODE=empty assert_wait fail "--wait: a ci run that never appears times out" 2
GH_DEPLOY_MODE=green GH_CI_MODE=red assert_wait fail "--wait: a red ci run still fails" 10
rm -rf "$GH_FLIP_DIR" && mkdir -p "$GH_FLIP_DIR"
GH_DEPLOY_MODE=flip GH_CI_MODE=flip assert fail "without --wait a run in progress still fails"

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

# --- --feature <branch> checks the NAMED branch, not whatever is checked out (#76 / #1226) ---
# feature/named is left pointing at the SAME commit as dev's current tip (no
# extra commit): this is exactly the case the bug missed — comparing HEAD
# (dev's, since that's what's actually checked out) against
# origin/feature/named happens to match by coincidence, so the old code
# reported a false PASS for a branch that was never actually checked out.
git branch feature/named
git push -q origin feature/named
assert_feature_arg fail "--feature <branch> run from a different checkout is rejected, even when HEAD happens to match the named branch's SHA" feature/named
git switch -q feature/named
assert_feature_arg pass "--feature <branch> passes once that branch is actually checked out" feature/named
git switch -q dev
git branch -qD feature/named

# --- "branched off dev" must fail for a branch forked from master once dev
# --- has diverged from it, not just because they share history (#76 / #1225) ---
echo diverge >>code.ts && git add code.ts && git commit -q -m "dev-only work, not promoted" && git push -q origin dev
git fetch -q origin
git switch -qc fix/from-master origin/master
echo from-master >from-master.txt && git add from-master.txt && git commit -q -m "forked from master, not dev"
git push -q origin fix/from-master
assert_feature_arg fail "branch forked from master (dev has since diverged) is rejected" fix/from-master
git switch -q dev
git branch -qD fix/from-master
git push -q origin --delete fix/from-master
git push -q origin dev:master
git fetch -q origin

echo
echo "verify-done tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
