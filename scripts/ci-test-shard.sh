#!/usr/bin/env bash
# ci-test-shard.sh — run one slice of `pnpm test:cov` so CI can spread the suites
# over parallel jobs.
#
# Usage: bash scripts/ci-test-shard.sh <api|web|packages>
#
# The package list stays the `--filter` list of the root `test:cov` script, the
# one scripts/test-cov-complete.sh keeps complete. `api` and `web` are the two
# slowest suites and get a job each; `packages` is every other entry. A suite is
# never split across jobs, because each package's coverage thresholds apply to
# its whole run.
#
# Environment:
#   PNPM_WORKSPACE_CONCURRENCY  packages run in parallel within the slice (default 4)
#   CI_TEST_SHARD_DRY_RUN=1     print the selected packages instead of running them
#
# Exit 0 = the slice passed (or was printed); 2 = unknown slice or a package list
# that does not contain the api/web suites; otherwise vitest's exit code.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

shard=${1:-}
cov_line=$(node -e "process.stdout.write(require('./package.json').scripts['test:cov'] ?? '')")

all=()
while IFS= read -r name; do
  [ -n "$name" ] && all+=("$name")
done < <(printf '%s\n' "$cov_line" | grep -oE -- '--filter [^ ]+' | cut -d' ' -f2)

contains() {
  local needle=$1 item
  shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

if ! contains @squad/api "${all[@]}" || ! contains @squad/web "${all[@]}"; then
  echo "ci-test-shard: test:cov no longer lists @squad/api and @squad/web" >&2
  exit 2
fi

selected=()
case "$shard" in
api) selected=(@squad/api) ;;
web) selected=(@squad/web) ;;
packages)
  for name in "${all[@]}"; do
    case "$name" in @squad/api | @squad/web) ;; *) selected+=("$name") ;; esac
  done
  ;;
*)
  echo "usage: ci-test-shard.sh <api|web|packages>" >&2
  exit 2
  ;;
esac

if [ "${CI_TEST_SHARD_DRY_RUN:-}" = 1 ]; then
  printf '%s\n' "${selected[@]}"
  exit 0
fi

filters=()
for name in "${selected[@]}"; do filters+=(--filter "$name"); done
exec pnpm --workspace-concurrency="${PNPM_WORKSPACE_CONCURRENCY:-4}" "${filters[@]}" \
  exec vitest run --coverage
