#!/usr/bin/env bash
# verify-done.sh — mechanical completion verification for the CLAUDE.md
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
#   4. the dev stand runs this tip: the `deploy-tk104` run for the current dev
#      tip succeeded (a tip that only changes docs, which the deploy ignores,
#      is covered by the last green deploy of an ancestor);
#   5. the tip is promoted — `origin/master` is the dev tip — and the `ci`
#      workflow, which runs only on master, is green FOR THAT SHA. A green
#      run on an older SHA does not count.
#
# Exit 0 = all checks passed; exit 1 = at least one failed (task is NOT done).
# Requires: git, gh (authenticated), jq.
#
# Used by every coding agent before reporting a task complete; see CLAUDE.md
# "Completion verification" and docs/development/agent-harness.md.

set -u

# Mode selection:
#   (default)          integration mode — the finished-and-integrated state:
#                      on dev, dev == origin/dev, deployed to the dev stand,
#                      promoted to master with a green ci run.
#   --feature [branch] parallel-wave handoff mode — a work branch is implemented,
#                      tested, committed and pushed, ready for the orchestrator to
#                      integrate. There is deliberately NO deploy or CI check
#                      here: the branch has not been merged yet. Use this to attest a wave
#                      task done; the orchestrator runs the default mode after
#                      merging to dev. See CLAUDE.md "Parallel-wave handoff".
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
  fail "on '$branch', not 'dev' — finished work must be merged into dev (see CLAUDE.md workflow)"
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

# Prints "<status> <conclusion> <run id>" for the newest run of a workflow on
# a branch at exactly the given SHA, or nothing when there is none.
run_for_sha() {
  gh run list --branch "$1" --workflow "$2" --limit 30 \
    --json headSha,status,conclusion,databaseId 2>/dev/null |
    jq -r --arg sha "$3" '[.[] | select(.headSha == $sha)][0] // empty | "\(.status) \(.conclusion) \(.databaseId)"'
}

# check_run <label> <status conclusion id> <sha> <hint>
check_run() {
  local label=$1 run=$2 sha=$3 hint=$4 status rest conclusion run_id
  status=${run%% *}
  rest=${run#* }
  conclusion=${rest%% *}
  run_id=${rest#* }
  if [ "$status" != "completed" ]; then
    fail "$label run $run_id for $sha is still $status — work is not done until it is green (gh run watch $run_id)"
  elif [ "$conclusion" = "success" ]; then
    pass "$label green at $sha (run $run_id)"
  else
    fail "$label run $run_id for $sha concluded '$conclusion' — $hint"
  fi
}

# --- 4. the dev stand runs this tip -------------------------------------------
# deploy-tk104.yml ignores pushes that only touch Markdown or docs/, so such a
# tip has no deploy run of its own; the newest green deploy of an ancestor
# then already serves everything the tip changes.
deploy_run=$(run_for_sha dev deploy-tk104.yml "$dev_sha")
if [ -n "$deploy_run" ]; then
  check_run "dev stand deploy" "$deploy_run" "$dev_sha" "fix forward and push dev again"
else
  deployed_sha=$(gh run list --branch dev --workflow deploy-tk104.yml --limit 30 \
    --json headSha,status,conclusion 2>/dev/null |
    jq -r '.[] | select(.status == "completed" and .conclusion == "success") | .headSha' |
    while read -r sha; do
      if git merge-base --is-ancestor "$sha" "$dev_sha" 2>/dev/null; then
        echo "$sha"
        break
      fi
    done)
  if [ -z "$deployed_sha" ]; then
    fail "no deploy-tk104 run for the current dev tip $dev_sha — push dev and watch the deploy (gh run watch)"
  elif git diff --name-only "$deployed_sha" "$dev_sha" | grep -qvE '(\.md$|^docs/)'; then
    fail "no deploy-tk104 run for the current dev tip $dev_sha, and it changes deployable files since the last green deploy ${deployed_sha:0:12}"
  else
    pass "dev tip only changes docs since the last green deploy ${deployed_sha:0:12}"
  fi
fi

# --- 5. promoted to master and ci green for THIS tip ------------------------
master_sha=$(git rev-parse origin/master 2>/dev/null || echo "")
if [ -n "$dev_sha" ] && [ "$master_sha" = "$dev_sha" ]; then
  pass "dev tip promoted (origin/master == origin/dev == ${dev_sha:0:12})"
  ci_run=$(run_for_sha master ci.yml "$dev_sha")
  if [ -z "$ci_run" ]; then
    fail "no ci run found on master for $dev_sha — watch the run the promotion started (gh run watch)"
  else
    check_run "master ci" "$ci_run" "$dev_sha" "fix forward on dev and promote again"
  fi
else
  fail "origin/master ($master_sha) is not the dev tip ($dev_sha) — promote with: git push origin origin/dev:master"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify-done: PASSED — mechanical state checks hold. Judgment angles (requirements, runtime evidence, diff review, docs) still apply; see CLAUDE.md."
  exit 0
fi
echo "verify-done: FAILED — the task is NOT done. Fix the failures above and re-run."
exit 1
