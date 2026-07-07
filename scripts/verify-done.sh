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
#   4. the `ci` workflow is green on GitHub FOR THE CURRENT dev tip —
#      a green run for an older SHA does not count.
#
# Exit 0 = all checks passed; exit 1 = at least one failed (task is NOT done).
# Requires: git, gh (authenticated), jq.
#
# Used by every coding agent before reporting a task complete; see AGENTS.md
# "Completion verification" and docs/development/agent-harness.md.

set -u

FAIL=0

pass() { echo "  PASS $1"; }
fail() {
  echo "  FAIL $1"
  FAIL=1
}

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

# --- 4. dev CI green for THIS tip ---------------------------------------------
run=$(gh run list --branch dev --workflow ci --limit 15 \
  --json headSha,status,conclusion,databaseId 2>/dev/null |
  jq -r --arg sha "$dev_sha" '[.[] | select(.headSha == $sha)][0] // empty | "\(.status) \(.conclusion) \(.databaseId)"')
if [ -z "$run" ]; then
  fail "no ci run found for the current dev tip $dev_sha — push dev and watch the run (gh run watch)"
else
  status=${run%% *}
  rest=${run#* }
  conclusion=${rest%% *}
  run_id=${rest#* }
  if [ "$status" != "completed" ]; then
    fail "ci run $run_id for $dev_sha is still $status — work is not done until it is green (gh run watch $run_id)"
  elif [ "$conclusion" = "success" ]; then
    pass "dev ci green at current tip (run $run_id)"
  else
    fail "ci run $run_id for $dev_sha concluded '$conclusion' — fix forward until green"
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify-done: PASSED — mechanical state checks hold. Judgment angles (requirements, runtime evidence, diff review, docs) still apply; see AGENTS.md."
  exit 0
fi
echo "verify-done: FAILED — the task is NOT done. Fix the failures above and re-run."
exit 1
