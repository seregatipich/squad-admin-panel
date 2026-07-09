#!/usr/bin/env bash
# verify-done.sh — mechanical completion verification for the AGENTS.md
# "Completion verification" checklist.
#
# Verifies the git/CI state a finished task must be in. It does NOT replace
# the judgment angles (requirements coverage, runtime verification, diff
# self-review, docs) or the local gate (typecheck / biome / tests) — it
# proves the state claims that agents most often get wrong:
#
#   1. the working tree is clean (everything committed);
#   2. you are on `dev` and it matches `origin/dev` (everything pushed);
#   3. the branch model is intact (git-guard doctor reports no problems);
#   4. the local test gate is wired — `scripts/pre-push-checklist.sh` exists and
#      the lefthook `pre-push` hook invokes it. Cloud CI is disabled, so this
#      checklist (typecheck/biome/build/tests) is the gate, enforced on push.
#
# Exit 0 = all checks passed; exit 1 = at least one failed (task is NOT done).
# Requires: git, jq.
#
# Used by every coding agent before reporting a task complete; see AGENTS.md
# "Completion verification" and docs/development/agent-harness.md.

set -u

# Mode selection:
#   (default)          dev-integration mode — the finished-and-integrated state:
#                      on dev, dev == origin/dev, local test gate wired.
#   --feature [branch] parallel-wave handoff mode — a work branch is implemented,
#                      tested, committed and pushed, ready for the orchestrator to
#                      integrate. There is deliberately NO dev-CI check here: the
#                      branch has not been merged yet. Use this to attest a wave
#                      task done; the orchestrator runs the default mode after
#                      merging to dev. See AGENTS.md "Parallel-wave handoff".
MODE=dev
FEATURE_BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
  --feature)
    MODE=feature
    shift
    case "${1:-}" in
    "" | -*) ;;
    *)
      FEATURE_BRANCH=$1
      shift
      ;;
    esac
    ;;
  -h | --help)
    echo "usage: verify-done.sh [--feature [branch]]"
    exit 0
    ;;
  *)
    echo "verify-done: unknown argument '$1'" >&2
    exit 2
    ;;
  esac
done

FAIL=0

pass() { echo "  PASS $1"; }
fail() {
  echo "  FAIL $1"
  FAIL=1
}

if [ "$MODE" = feature ]; then
  echo "verify-done: parallel-wave feature-branch handoff checks"
  command -v git >/dev/null 2>&1 || {
    fail "required tool 'git' is not installed"
    exit 1
  }

  branch=${FEATURE_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}
  case "$branch" in
  master | main | dev | HEAD | "")
    fail "'$branch' is not a work branch — a wave task must live on feature/<slug> (or fix/…, chore/…)"
    echo "verify-done: FAILED — not on a work branch."
    exit 1
    ;;
  esac
  pass "on work branch '$branch'"

  if [ -z "$(git status --porcelain)" ]; then
    pass "working tree clean"
  else
    fail "working tree has uncommitted changes (git status) — commit your work"
  fi

  git fetch --quiet origin || fail "git fetch origin failed"

  head_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
  remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")
  if [ -z "$remote_sha" ]; then
    fail "origin/$branch does not exist — push it: git push -u origin $branch"
  elif [ "$head_sha" = "$remote_sha" ]; then
    pass "branch pushed (HEAD == origin/$branch == ${head_sha:0:12})"
  else
    fail "HEAD ($head_sha) != origin/$branch ($remote_sha) — push your latest commits"
  fi

  if git merge-base origin/dev HEAD >/dev/null 2>&1; then
    pass "branch shares history with origin/dev (branched off dev)"
  else
    fail "branch has no common history with origin/dev — work branches must be created from dev"
  fi

  echo
  if [ "$FAIL" -eq 0 ]; then
    echo "verify-done: PASSED (handoff) — branch implemented, committed, pushed. Judgment angles"
    echo "(requirements, tests actually run, diff review) still apply; the orchestrator integrates to dev."
    exit 0
  fi
  echo "verify-done: FAILED — the wave task is NOT ready to hand off. Fix the failures above."
  exit 1
fi

echo "verify-done: mechanical completion checks"

for tool in git gh jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "required tool '$tool' is not installed"
    echo "verify-done: FAILED"
    exit 1
  fi
done

# --- 1. everything committed -------------------------------------------------
if [ -z "$(git status --porcelain)" ]; then
  pass "working tree clean"
else
  fail "working tree has uncommitted changes (git status)"
fi

# --- 2. everything merged and pushed -----------------------------------------
git fetch --quiet origin || fail "git fetch origin failed"

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$branch" = "dev" ]; then
  pass "on integration branch dev"
else
  fail "on '$branch', not 'dev' — finished work must be merged into dev (see AGENTS.md workflow)"
fi

head_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
dev_sha=$(git rev-parse origin/dev 2>/dev/null || echo "")
if [ -n "$head_sha" ] && [ "$head_sha" = "$dev_sha" ]; then
  pass "dev is pushed (HEAD == origin/dev == ${dev_sha:0:12})"
else
  fail "HEAD ($head_sha) != origin/dev ($dev_sha) — merge and push your work"
fi

# --- 3. branch model intact ---------------------------------------------------
doctor_out=$("$(cd "$(dirname "$0")" && pwd)/git-guard.sh" doctor 2>&1 || true)
if printf '%s' "$doctor_out" | grep -q 'WARN'; then
  fail "git-guard doctor reports problems:"
  printf '%s\n' "$doctor_out" | grep 'WARN' | sed 's/^/       /'
else
  pass "git-guard doctor clean"
fi

# --- 4. local test gate wired (cloud CI disabled) ----------------------------
# The self-hosted runners are retired, so the test gate is scripts/pre-push-
# checklist.sh, enforced by the lefthook pre-push hook (it blocks pushes that
# fail typecheck/biome/build/tests). Here we confirm that gate is in place; the
# hook already ran it for the pushed dev tip (unless bypassed with --no-verify).
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ ! -x "$script_dir/pre-push-checklist.sh" ]; then
  fail "local test gate missing — scripts/pre-push-checklist.sh not found or not executable"
elif [ -n "$repo_root" ] && [ -f "$repo_root/lefthook.yml" ] && \
     ! grep -q 'pre-push-checklist.sh' "$repo_root/lefthook.yml"; then
  fail "local test gate not wired — lefthook.yml pre-push does not invoke pre-push-checklist.sh"
else
  pass "local test gate wired (pre-push checklist enforced at push; cloud CI disabled)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify-done: PASSED — mechanical state checks hold. Judgment angles (requirements, runtime evidence, diff review, docs) still apply; see AGENTS.md."
  exit 0
fi
echo "verify-done: FAILED — the task is NOT done. Fix the failures above and re-run."
exit 1
