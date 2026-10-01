#!/usr/bin/env bash
# ci-test-shard.sh — run one slice of `pnpm test:cov` so CI can spread the suites
# over parallel jobs.
#
# Usage: bash scripts/ci-test-shard.sh api <index> <count>
#        bash scripts/ci-test-shard.sh web <index> <count>
#        bash scripts/ci-test-shard.sh packages [<index> <count>]
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
# thresholds, so unlike api/web it needs no blob merge: with `<index> <count>` it
# takes the packages that a weighted assignment gives the <index>-th slice.
# Without them it runs them all. The assignment is deterministic
# longest-processing-time-first: packages are ordered by their WEIGHTS entry
# (seconds measured on CI, heaviest first, ties by name) and each goes to the
# slice with the least weight so far (ties to the lowest index), so the slices
# finish together instead of one inheriting the long suites. A package without
# an entry weighs the median of the table. Within a slice the suites run in a
# pool of PNPM_WORKSPACE_CONCURRENCY packages. pnpm cannot run them in a chosen
# order (`--no-sort` sorts by directory, which starts the longest suites last),
# so the pool here starts the longest suites first and the short ones fill the
# remaining slots instead of stretching the tail.
#
# Refreshing WEIGHTS: every run logs "<pkg> passed in <N>s" per package and ends
# with a `pkg=seconds` line for each passed one. Paste the lines of a recent CI
# run's `test-packages` jobs into the table below.
#
# Environment:
#   PNPM_WORKSPACE_CONCURRENCY  packages run in parallel in the `packages` slice (default 4)
#   CI_TEST_SHARD_DRY_RUN=1     print the selected packages (in run order) instead of running them
#   CI_TEST_SHARD_WEIGHTS       space-separated `pkg=seconds` entries replacing the WEIGHTS table
#                               (used by the tests; also handy to try a new measurement)
#
# Exit 0 = the slice passed (or was printed); 2 = usage error, or a package list
# that does not contain the api/web suites; otherwise the tests failed.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

# Seconds each `packages` suite took on CI run 36859451031 (ubuntu-24.04, four
# suites in parallel per slice). Only the relative sizes matter; a stale entry
# merely unbalances the slices, never drops a package.
WEIGHTS=(
  @squad/db=83
  @squad/worker-log-ingest=64
  @squad/worker-rcon=50
  @squad/worker-ban-sync=36
  @squad/worker-config-sync=35
  @squad/worker-automation=32
  @squad/worker-discord=31
  @squad/worker-event-partition=30
  @squad/worker-media-publisher=28
  @squad/worker-role-expirer=24
  @squad/worker-clan-priority-expirer=23
  @squad/worker-clan-guard=23
  @squad/worker-scheduler=20
  @squad/worker-seed-reward=18
  @squad/shared-config=17
  @squad/worker-diag-flush=14
  @squad/shared-types=13
  @squad/worker-leaderboard-aggregator=11
  @squad/worker-presence-daily=11
  @squad/chat-ingest=9
  @squad/bridge-client=9
  @squad/worker-metrics-sampler=9
  @squad/worker-steam-refresh=9
  @squad/worker-stats=8
  @squad/worker-backup=6
  @squad/worker-audit-archiver=6
  panel-bridge=6
  @squad/diag=4
  @squad/steam-api=4
)

usage() {
  echo "usage: ci-test-shard.sh api <index> <count> | web <index> <count> | packages [<index> <count>]" >&2
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
packages)
  if [ $# -eq 3 ]; then
    [[ "$2" =~ ^[1-9][0-9]*$ && "$3" =~ ^[1-9][0-9]*$ && "$2" -le "$3" ]] || usage
    pkg_index=$2
    pkg_count=$3
  else
    [ $# -eq 1 ] || usage
    pkg_index=1
    pkg_count=1
  fi
  ;;
*) usage ;;
esac

if [ -n "${CI_TEST_SHARD_WEIGHTS:-}" ]; then
  # shellcheck disable=SC2206
  WEIGHTS=($CI_TEST_SHARD_WEIGHTS)
fi
for entry in "${WEIGHTS[@]}"; do
  [[ "$entry" =~ ^[^=]+=[0-9]+$ ]] || {
    echo "ci-test-shard: weight entry '$entry' is not <package>=<seconds>" >&2
    exit 2
  }
done

default_weight=$(for entry in "${WEIGHTS[@]}"; do echo "${entry#*=}"; done | sort -n |
  awk '{ w[NR] = $1 } END { print NR ? w[int((NR + 1) / 2)] : 1 }')

weight_of() {
  local entry
  for entry in "${WEIGHTS[@]}"; do
    [ "${entry%%=*}" = "$1" ] && {
      echo "${entry#*=}"
      return
    }
  done
  echo "$default_weight"
}

list_weights() {
  local name
  for name in "${all[@]}"; do
    case "$name" in @squad/api | @squad/web) continue ;; esac
    printf '%s\t%s\n' "$(weight_of "$name")" "$name"
  done
}
by_weight=$(list_weights | LC_ALL=C sort -t "$(printf '\t')" -k1,1nr -k2,2)

loads=()
for ((i = 0; i < pkg_count; i++)); do loads+=(0); done
ordered=()
while IFS=$'\t' read -r weight name; do
  [ -n "$name" ] || continue
  lightest=0
  for ((i = 1; i < pkg_count; i++)); do
    [ "${loads[$i]}" -lt "${loads[$lightest]}" ] && lightest=$i
  done
  loads[lightest]=$((loads[lightest] + weight))
  [ "$lightest" -eq $((pkg_index - 1)) ] && ordered+=("$name")
done <<<"$by_weight"

if [ "${CI_TEST_SHARD_DRY_RUN:-}" = 1 ]; then
  printf '%s\n' ${ordered[@]+"${ordered[@]}"}
  exit 0
fi
[ ${#ordered[@]} -gt 0 ] || { echo "ci-test-shard: slice $pkg_index/$pkg_count selected no package"; exit 0; }

concurrency=${PNPM_WORKSPACE_CONCURRENCY:-4}
[[ "$concurrency" =~ ^[1-9][0-9]*$ ]] || {
  echo "ci-test-shard: PNPM_WORKSPACE_CONCURRENCY must be a positive integer" >&2
  exit 2
}

# Every package runs to the end even after another failed, so one CI run
# reports every broken suite rather than the first.
failures=$(mktemp)
durations=$(mktemp)
trap 'rm -f "$failures" "$durations"' EXIT
export CI_TEST_SHARD_FAILURES=$failures CI_TEST_SHARD_DURATIONS=$durations
printf '%s\n' "${ordered[@]}" | xargs -P "$concurrency" -n 1 bash -c '
  started=$SECONDS
  if pnpm --filter "$1" exec vitest run --coverage; then
    echo "ci-test-shard: $1 passed in $((SECONDS - started))s"
    echo "$1=$((SECONDS - started))" >> "$CI_TEST_SHARD_DURATIONS"
  else
    echo "ci-test-shard: $1 FAILED after $((SECONDS - started))s" >&2
    echo "$1" >> "$CI_TEST_SHARD_FAILURES"
  fi' _

echo "ci-test-shard: measured seconds, ready for the WEIGHTS table:"
LC_ALL=C sort -t= -k2,2nr -k1,1 "$durations" | sed 's/^/  /'

if [ -s "$failures" ]; then
  echo "ci-test-shard: $(wc -l <"$failures" | tr -d ' ') package(s) failed:" >&2
  sed 's/^/  - /' "$failures" >&2
  exit 1
fi
echo "ci-test-shard: all ${#ordered[@]} packages passed"
