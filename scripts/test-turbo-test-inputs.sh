#!/usr/bin/env bash
# test-turbo-test-inputs.sh — contract test: the shared worker test code under
# apps/workers/_test-shared/ (heartbeat/SIGTERM contract, Redis-per-worker setup,
# vitest base config) is a sibling of the worker packages, not a package, so turbo's
# default inputs miss it. Every test task a worker runs must hash it, or an edit there
# replays a stale cached `test` result (#119).
#
# Two checks. The static one reads turbo.json with jq and needs nothing installed (the
# `branch-guard` job runs it without a node toolchain). The behavioural one asks turbo
# for the dry-run hash of a worker's test task before and after contract.ts changes; it
# runs when turbo is installed (`pnpm install`) and is reported as skipped otherwise.
# Run: bash scripts/test-turbo-test-inputs.sh
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root" || exit 1

fail() {
  echo "test-turbo-test-inputs: FAIL — $1" >&2
  exit 1
}

worker='@squad/worker-stats'
shared=apps/workers/_test-shared/contract.ts
glob='$TURBO_ROOT$/apps/workers/_test-shared/**'
[ -f "$shared" ] || fail "$shared does not exist"
command -v jq >/dev/null 2>&1 || fail 'jq is required'

# --- Static: every task a worker's tests run lists the shared directory as an input. ---
for task in test test:unit test:integration; do
  jq -e --arg task "$task" --arg glob "$glob" '.tasks[$task].inputs // [] | index($glob) != null' turbo.json >/dev/null ||
    fail "turbo.json task '$task' does not list $glob among its inputs"
done

# --- Behavioural: editing the shared contract changes the worker's test hash. ---
if [ ! -x node_modules/.bin/turbo ]; then
  echo "test-turbo-test-inputs: OK (static) — the dry-run hash check is skipped: turbo is not installed (run pnpm install)"
  exit 0
fi

hash_of() {
  node_modules/.bin/turbo run test "--filter=$worker" --dry=json 2>/dev/null |
    jq -r --arg id "$worker#test" '.tasks[] | select(.taskId == $id) | .hash'
}

backup=$(mktemp)
cp "$shared" "$backup"
trap 'cp "$backup" "$repo_root/$shared"; rm -f "$backup"' EXIT

before=$(hash_of)
[ -n "$before" ] || fail "turbo printed no hash for $worker#test"
printf '\n// test-turbo-test-inputs probe\n' >>"$shared"
after=$(hash_of)
cp "$backup" "$shared"
restored=$(hash_of)

[ "$before" != "$after" ] || fail "editing $shared did not change the $worker#test hash ($before)"
[ "$before" = "$restored" ] || fail "restoring $shared did not restore the hash ($before vs $restored)"

echo "test-turbo-test-inputs: OK — $worker#test hash $before changes when the shared worker test code changes"
