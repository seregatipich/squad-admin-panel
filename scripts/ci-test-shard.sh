#!/usr/bin/env bash
# ci-test-shard.sh — run one slice of `pnpm test:cov` so CI can spread the suites
# over parallel jobs.
#
# Usage: bash scripts/ci-test-shard.sh api <index> <count>
#        bash scripts/ci-test-shard.sh web <index> <count>
#        bash scripts/ci-test-shard.sh packages
#
# The package list stays the `--filter` list of the root `test:cov` script, the
# one scripts/test-cov-complete.sh keeps complete.
#
# `api` and `web` are the two slowest suites, so each is split by test file with
# vitest's `--shard=<index>/<count>`. One shard sees only part of the suite, so
# its coverage cannot meet the package's thresholds: the shard switches them off
# and writes a blob report to <package>/.vitest-reports/blob-<index>-<count>.json
# instead. The ci `gate` job merges every shard's blob with
# `vitest --merge-reports --coverage`, which applies the thresholds from the
# package's vitest.config.ts to the merged coverage.
#
# `packages` is every other entry. Each suite runs whole under its own
# thresholds, in a pool of PNPM_WORKSPACE_CONCURRENCY packages. pnpm cannot run
# them in a chosen order (`--no-sort` sorts by directory, which starts the
# longest suites last), so the pool here starts the longest suites first and
# the short ones fill the remaining slots instead of stretching the tail.
#
# Environment:
#   PNPM_WORKSPACE_CONCURRENCY  packages run in parallel in the `packages` slice (default 4)
#   CI_TEST_SHARD_DRY_RUN=1     print the selected packages (in run order) instead of running them
#
# Exit 0 = the slice passed (or was printed); 2 = usage error, or a package list
# that does not contain the api/web suites; otherwise the tests failed.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

# The longest `packages` suites, measured on CI; the rest keep test:cov order.
LONGEST_FIRST=(@squad/db @squad/worker-log-ingest @squad/worker-rcon)

usage() {
  echo "usage: ci-test-shard.sh api <index> <count> | web <index> <count> | packages" >&2
  exit 2
}

slice=${1:-}
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

run_sharded() {
  local package=$1 index=${2:-} count=${3:-}
  [[ "$index" =~ ^[1-9][0-9]*$ && "$count" =~ ^[1-9][0-9]*$ ]] || usage
  [ "$index" -le "$count" ] || usage
  if [ "${CI_TEST_SHARD_DRY_RUN:-}" = 1 ]; then
    printf '%s\n' "$package"
    return 0
  fi
  exec pnpm --filter "$package" exec vitest run \
    --shard="$index/$count" \
    --reporter=default --reporter=blob \
    --outputFile.blob=".vitest-reports/blob-$index-$count.json" \
    --coverage \
    --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \
    --coverage.thresholds.branches=0 --coverage.thresholds.statements=0
}

case "$slice" in
api)
  [ $# -eq 3 ] || usage
  run_sharded @squad/api "$2" "$3"
  exit 0
  ;;
web)
  [ $# -eq 3 ] || usage
  run_sharded @squad/web "$2" "$3"
  exit 0
  ;;
packages) [ $# -eq 1 ] || usage ;;
*) usage ;;
esac

ordered=()
for name in "${LONGEST_FIRST[@]}"; do
  contains "$name" "${all[@]}" && ordered+=("$name")
done
for name in "${all[@]}"; do
  case "$name" in @squad/api | @squad/web) continue ;; esac
  contains "$name" "${LONGEST_FIRST[@]}" || ordered+=("$name")
done

if [ "${CI_TEST_SHARD_DRY_RUN:-}" = 1 ]; then
  printf '%s\n' "${ordered[@]}"
  exit 0
fi

concurrency=${PNPM_WORKSPACE_CONCURRENCY:-4}
[[ "$concurrency" =~ ^[1-9][0-9]*$ ]] || {
  echo "ci-test-shard: PNPM_WORKSPACE_CONCURRENCY must be a positive integer" >&2
  exit 2
}

# Every package runs to the end even after another failed, so one CI run
# reports every broken suite rather than the first.
failures=$(mktemp)
trap 'rm -f "$failures"' EXIT
export CI_TEST_SHARD_FAILURES=$failures
printf '%s\n' "${ordered[@]}" | xargs -P "$concurrency" -n 1 bash -c '
  started=$SECONDS
  if pnpm --filter "$1" exec vitest run --coverage; then
    echo "ci-test-shard: $1 passed in $((SECONDS - started))s"
  else
    echo "ci-test-shard: $1 FAILED after $((SECONDS - started))s" >&2
    echo "$1" >> "$CI_TEST_SHARD_FAILURES"
  fi' _

if [ -s "$failures" ]; then
  echo "ci-test-shard: $(wc -l <"$failures" | tr -d ' ') package(s) failed:" >&2
  sed 's/^/  - /' "$failures" >&2
  exit 1
fi
echo "ci-test-shard: all ${#ordered[@]} packages passed"
