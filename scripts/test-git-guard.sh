#!/usr/bin/env bash
# test-git-guard.sh — test suite for scripts/git-guard.sh.
#
# Builds throwaway git repositories under a temp directory and asserts the
# guard's allow/deny decision for every rule in the branch model. Run locally
# (bash 3.2+) or in CI: `bash scripts/test-git-guard.sh`. Exits non-zero on
# any failure.

set -u

# Fixture repos must not trigger the developer's own git hooks.
export LEFTHOOK=0

GUARD=$(cd "$(dirname "$0")" && pwd)/git-guard.sh
TMP=$(mktemp -d "${TMPDIR:-/tmp}/git-guard-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

# assert <expected: allow|deny> <description> -- <guard args...>
assert() {
  local expected=$1 desc=$2
  shift 3
  local out rc
  out=$("$GUARD" "$@" 2>&1)
  rc=$?
  local got="allow"
  [ $rc -eq 2 ] && got="deny"
  if [ $rc -ne 0 ] && [ $rc -ne 2 ]; then
    got="error($rc)"
  fi
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got"
    echo "      guard output: $out"
  fi
}

# assert_push <expected> <description> <stdin refspec line>
assert_push() {
  local expected=$1 desc=$2 line=$3
  local out rc
  out=$(echo "$line" | "$GUARD" check-push origin git@example.com:repo.git 2>&1)
  rc=$?
  local got="allow"
  [ $rc -eq 2 ] && got="deny"
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got"
    echo "      guard output: $out"
  fi
}

git_q() { git "$@" >/dev/null 2>&1; }

# --- fixture repo -----------------------------------------------------------
# master --- dev (ahead of master) --- feature/x (on dev) ; stray branch off
# master with a commit NOT reachable from dev; bare origin with master+dev.
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
git_q switch -c feature/x
echo three >>file && git add file && git_q commit -m "feature work"
git_q switch master
git_q branch stray master
git_q switch stray
echo rogue >rogue && git add rogue && git_q commit -m "not via dev"
git_q switch feature/x
git remote add origin "$ORIGIN"
git_q push origin master dev

# The guard scopes check-command to the repository it is installed in
# (located via its own path), so run the fixture against a copy installed
# into the fixture repo — exactly how it ships in real checkouts.
mkdir -p "$REPO/scripts"
cp "$GUARD" "$REPO/scripts/git-guard.sh"
GUARD="$REPO/scripts/git-guard.sh"

# A second, foreign repository: the guard must not police it.
OTHER="$TMP/other"
git init -q -b master "$OTHER"
git -C "$OTHER" config user.email guard-test@example.com
git -C "$OTHER" config user.name "guard test"
git -C "$OTHER" commit -q --allow-empty -m root

DEV_SHA=$(git rev-parse dev)
STRAY_SHA=$(git rev-parse stray)
MASTER_SHA=$(git rev-parse master)
ZERO="0000000000000000000000000000000000000000"

# --- check-command: pass-through -------------------------------------------
assert allow "non-git command" -- check-command "ls -la && pnpm test"
assert allow "git status" -- check-command "git status"
assert allow "git log on master history" -- check-command "git log master"

# --- check-command: main-branch ban -----------------------------------------
assert deny "checkout -b main" -- check-command "git checkout -b main"
assert deny "switch -c main" -- check-command "git switch -c main"
assert deny "switch -C main" -- check-command "git switch -C main"
assert deny "branch main" -- check-command "git branch main"
assert deny "branch rename to main" -- check-command "git branch -m main"
assert deny "checkout bare main" -- check-command "git checkout main"
assert deny "push new main" -- check-command "git push origin main"
assert deny "push refspec to main" -- check-command "git push origin dev:main"
assert deny "push HEAD to refs/heads/main" -- check-command "git push origin HEAD:refs/heads/main"
assert deny "track origin/main" -- check-command "git checkout --track origin/main"
assert allow "delete local main is fine" -- check-command "git branch -D main"
assert allow "branch named mainline is fine" -- check-command "git switch -c feature/mainline"

# --- check-command: commits on protected branches ---------------------------
git_q switch master
assert deny "commit on master" -- check-command "git commit -m x"
assert deny "commit on master inside compound" -- check-command "git add . && git commit -m x"
assert deny "commit on master with env prefix" -- check-command "GIT_AUTHOR_NAME=x git commit -m x"
git_q switch dev
assert deny "commit on dev" -- check-command "git commit -m x"
git rev-parse feature/x >"$(git rev-parse --git-dir)/MERGE_HEAD"
assert allow "commit on dev mid-merge" -- check-command "git commit -m x"
rm "$(git rev-parse --git-dir)/MERGE_HEAD"
git_q switch feature/x
assert allow "commit on work branch" -- check-command "git commit -m x"

# --- check-command: branch creation source ----------------------------------
assert deny "new branch from master" -- check-command "git switch -c feature/y master"
assert deny "new branch from origin/master" -- check-command "git checkout -b feature/y origin/master"
assert allow "new branch from origin/dev" -- check-command "git switch -c feature/y origin/dev"
assert deny "branch <new> master" -- check-command "git branch feature/y master"
git_q switch master
assert deny "switch -c while on master" -- check-command "git switch -c feature/y"
git_q switch dev
assert allow "switch -c while on dev" -- check-command "git switch -c feature/y"

# --- check-command: merges ---------------------------------------------------
git_q switch master
assert deny "merge work branch into master" -- check-command "git merge --no-ff feature/x"
assert allow "merge dev into master" -- check-command "git merge dev"
git_q switch dev
assert allow "merge work branch into dev" -- check-command "git merge --no-ff feature/x"
assert deny "merge main anywhere" -- check-command "git merge main"
git_q switch feature/x

# --- check-command: pushes ---------------------------------------------------
assert deny "push stray sha to master" -- check-command "git push origin stray:master"
assert allow "push dev to master (promotion source reachable)" -- check-command "git push origin dev:master"
assert allow "ff promotion via origin/dev refspec" -- check-command "git push origin origin/dev:master"
assert allow "push work branch" -- check-command "git push origin feature/x"
assert allow "push dev" -- check-command "git push origin dev"
assert deny "force push master" -- check-command "git push --force origin master"
assert deny "force push dev" -- check-command "git push -f origin dev"
assert deny "plus-refspec force to master" -- check-command "git push origin +stray:master"
assert allow "force push own work branch" -- check-command "git push --force origin feature/x"
assert deny "delete remote dev" -- check-command "git push origin --delete dev"
assert deny "delete remote master via refspec" -- check-command "git push origin :master"
assert deny "push --all" -- check-command "git push --all origin"
assert deny "push --mirror" -- check-command "git push --mirror origin"

# push with no refspec: destination is the current branch
git_q switch master
assert allow "bare push on master at dev-reachable sha" -- check-command "git push origin"
echo drift >>file && git add file && git_q commit -m "master drift"
assert deny "bare push on master ahead of dev" -- check-command "git push"
git_q reset --hard "$MASTER_SHA"
git_q switch feature/x

# --- check-command: scoped to this repository --------------------------------
git_q switch master
assert allow "commit in a foreign repo via cd" -- check-command "cd $OTHER && git commit -m x"
assert allow "commit in a foreign repo via -C" -- check-command "git -C $OTHER commit -m x"
assert allow "main branch in a foreign repo" -- check-command "git -C $OTHER checkout -b main"
assert allow "commit after cd to a dynamic dir" -- check-command 'cd "$(mktemp -d)" && git commit -m x'
assert deny "commit after cd within this repo" -- check-command "cd . && git commit -m x"
git_q worktree add "$TMP/wt" dev
assert deny "commit on dev in a worktree of this repo" -- check-command "cd $TMP/wt && git commit -m x"
git_q worktree remove "$TMP/wt"
git_q switch feature/x

# --- check-commit (lefthook pre-commit) --------------------------------------
git_q switch master
assert deny "check-commit on master" -- check-commit
git_q switch dev
assert deny "check-commit on dev" -- check-commit
git rev-parse feature/x >"$(git rev-parse --git-dir)/MERGE_HEAD"
assert allow "check-commit on dev mid-merge" -- check-commit
rm "$(git rev-parse --git-dir)/MERGE_HEAD"
git_q switch feature/x
assert allow "check-commit on work branch" -- check-commit

# --- check-push (lefthook pre-push) ------------------------------------------
assert_push deny "pre-push: any main ref" "refs/heads/dev $DEV_SHA refs/heads/main $ZERO"
assert_push deny "pre-push: stray sha to master" "refs/heads/stray $STRAY_SHA refs/heads/master $MASTER_SHA"
assert_push allow "pre-push: dev sha to master" "refs/heads/dev $DEV_SHA refs/heads/master $MASTER_SHA"
assert_push deny "pre-push: delete dev" "(delete) $ZERO refs/heads/dev $DEV_SHA"
assert_push deny "pre-push: non-ff dev" "refs/heads/dev $MASTER_SHA refs/heads/dev $DEV_SHA"
assert_push allow "pre-push: work branch" "refs/heads/feature/x $(git rev-parse feature/x) refs/heads/feature/x $ZERO"

# --- doctor ------------------------------------------------------------------
assert allow "doctor always exits 0" -- doctor

echo
echo "git-guard tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
