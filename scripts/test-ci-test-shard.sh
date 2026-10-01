#!/usr/bin/env bash
# test-ci-test-shard.sh — the CI test slices together run exactly the `test:cov`
# package list: no package is dropped, none runs twice, the sharded suites hand
# vitest the arguments the ci gate's blob merge depends on, a failing package
# fails the slice without hiding the others, and bad arguments fail instead of
# silently running nothing. `pnpm` is replaced by a logging stub, so no test
# actually runs here.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
shard_script="$repo_root/scripts/ci-test-shard.sh"

fail() {
  echo "test-ci-test-shard: FAIL — $1" >&2
  exit 1
}

fixture=$(mktemp -d)
cleanup() {
  find "$fixture" -xdev -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

dry() {
  CI_TEST_SHARD_DRY_RUN=1 bash "$shard_script" "$@"
}

expect_usage_error() {
  local status
  CI_TEST_SHARD_DRY_RUN=1 bash "$shard_script" "$@" >/dev/null 2>&1
  status=$?
  [ "$status" -eq 2 ] || fail "'ci-test-shard.sh $*' exited $status instead of 2"
}

expected=$(cd "$repo_root" && node -e "process.stdout.write(require('./package.json').scripts['test:cov'] ?? '')" |
  grep -oE -- '--filter [^ ]+' | cut -d' ' -f2 | sort)
[ -n "$expected" ] || fail 'test:cov lists no packages'

# --- The slices cover test:cov exactly. ---
api=$(dry api 1 4) || fail 'api slice exited non-zero'
web=$(dry web 2 2) || fail 'web slice exited non-zero'
packages=$(dry packages) || fail 'packages slice exited non-zero'

[ "$api" = '@squad/api' ] || fail "api slice selected '$api'"
[ "$web" = '@squad/web' ] || fail "web slice selected '$web'"
if printf '%s\n' "$packages" | grep -Eqx '@squad/(api|web)'; then
  fail 'packages slice repeats the api or web suite'
fi

combined=$(printf '%s\n%s\n%s\n' "$api" "$web" "$packages" | sort)
[ "$combined" = "$expected" ] || fail "slices do not add up to test:cov:
$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$combined"))"
[ "$(printf '%s\n' "$combined" | uniq -d)" = '' ] || fail 'a package appears in two slices'

# The longest suites start first, so the short ones fill the pool around them
# instead of stretching the tail.
[ "$(printf '%s\n' "$packages" | head -n 3 | tr '\n' ' ')" = '@squad/db @squad/worker-log-ingest @squad/worker-rcon ' ] ||
  fail "packages slice does not start with db, log-ingest and rcon: $(printf '%s\n' "$packages" | head -n 3 | tr '\n' ' ')"

# --- A sharded packages slice: the shards partition the packages slice. ---
shard_count=3
sharded=''
for i in $(seq 1 $shard_count); do
  part=$(dry packages "$i" $shard_count) || fail "packages shard $i/$shard_count exited non-zero"
  [ -n "$part" ] || fail "packages shard $i/$shard_count selected nothing"
  sharded="$sharded$part"$'\n'
done
[ "$(printf '%s' "$sharded" | sort)" = "$(printf '%s\n' "$packages" | sort)" ] ||
  fail "packages shards do not add up to the packages slice:
$(diff <(printf '%s\n' "$packages" | sort) <(printf '%s' "$sharded" | sort))"
[ "$(printf '%s' "$sharded" | sort | uniq -d)" = '' ] || fail 'a package appears in two packages shards'
for i in 1 2 3; do
  [ "$(dry packages "$i" $shard_count | head -n 1)" = "$(printf '%s\n' @squad/db @squad/worker-log-ingest @squad/worker-rcon | sed -n "${i}p")" ] ||
    fail "packages shard $i/$shard_count does not start with its own long suite"
done
[ "$(dry packages 1 1)" = "$packages" ] || fail 'packages 1 1 differs from the unsharded slice'

# --- The WEIGHTS table: current, and the shards it produces are balanced. ---
weights=$(sed -n '/^WEIGHTS=($/,/^)$/p' "$shard_script" | sed '1d;$d' | tr -d ' ')
[ -n "$weights" ] || fail 'ci-test-shard.sh has no WEIGHTS table'
printf '%s\n' "$weights" | grep -Evq '^[^=]+=[0-9]+$' && fail 'a WEIGHTS entry is not <package>=<seconds>'
[ "$(printf '%s\n' "$weights" | cut -d= -f1 | sort | uniq -d)" = '' ] || fail 'a package has two WEIGHTS entries'
unknown=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$weights" | cut -d= -f1 | sort))
[ -z "$unknown" ] || fail "WEIGHTS names packages test:cov no longer lists: $unknown"

# Longest-processing-time-first leaves the heaviest and the lightest shard at
# most one package's weight apart, however the table is refreshed.
loads=''
for i in $(seq 1 $shard_count); do
  loads="$loads$(dry packages "$i" $shard_count | while read -r name; do
    printf '%s\n' "$weights" | sed -n "s|^$name=||p"
  done | awk '{ s += $1 } END { print s + 0 }')"$'\n'
done
heaviest_entry=$(printf '%s\n' "$weights" | cut -d= -f2 | sort -n | tail -n 1)
spread=$(printf '%s' "$loads" | sort -n | awk 'NR == 1 { low = $1 } { high = $1 } END { print high - low }')
[ "$spread" -le "$heaviest_entry" ] ||
  fail "packages shards are unbalanced: loads $(printf '%s' "$loads" | tr '\n' ' ')differ by ${spread}s"

# --- Weighted assignment on a known package list. ---
# p-a..p-e carry weights 10/7/6/5/4 and p-f none, so it weighs their median (6).
# Heaviest first, each package goes to the least-loaded shard (the lowest index
# on a tie): p-a -> 1, p-b -> 2, p-c -> 2, p-f -> 1, p-d -> 2, p-e -> 1.
mkdir -p "$fixture/weighted/scripts"
cp "$shard_script" "$fixture/weighted/scripts/ci-test-shard.sh"
printf '%s\n' '{"scripts":{"test:cov":"pnpm --filter @squad/api --filter @squad/web --filter p-f --filter p-e --filter p-d --filter p-c --filter p-b --filter p-a exec vitest run --coverage"}}' \
  >"$fixture/weighted/package.json"
weighted() {
  CI_TEST_SHARD_DRY_RUN=1 CI_TEST_SHARD_WEIGHTS='p-a=10 p-b=7 p-c=6 p-d=5 p-e=4' \
    bash "$fixture/weighted/scripts/ci-test-shard.sh" packages "$@"
}
[ "$(weighted 1 2 | tr '\n' ' ')" = 'p-a p-f p-e ' ] || fail "weighted shard 1/2 selected '$(weighted 1 2 | tr '\n' ' ')'"
[ "$(weighted 2 2 | tr '\n' ' ')" = 'p-b p-c p-d ' ] || fail "weighted shard 2/2 selected '$(weighted 2 2 | tr '\n' ' ')'"
[ "$(weighted | tr '\n' ' ')" = 'p-a p-b p-c p-f p-d p-e ' ] || fail "weighted unsharded slice ran '$(weighted | tr '\n' ' ')'"
# A weight beats declaration order: the last-listed package is heaviest here.
[ "$(CI_TEST_SHARD_DRY_RUN=1 CI_TEST_SHARD_WEIGHTS='p-a=1 p-b=1 p-c=1 p-d=1 p-e=1 p-f=99' \
  bash "$fixture/weighted/scripts/ci-test-shard.sh" packages 1 2 | head -n 1)" = 'p-f' ] ||
  fail 'the heaviest package is not first in its shard'
# More shards than packages leaves the extra shards empty rather than failing.
[ "$(weighted 6 6 | tr '\n' ' ')" = 'p-e ' ] || fail "weighted shard 6/6 selected '$(weighted 6 6 | tr '\n' ' ')'"
CI_TEST_SHARD_DRY_RUN=1 CI_TEST_SHARD_WEIGHTS='p-a=ten' bash "$shard_script" packages >/dev/null 2>&1
[ $? -eq 2 ] || fail 'a malformed CI_TEST_SHARD_WEIGHTS entry does not exit 2'

# --- Bad arguments exit 2. ---
expect_usage_error packages 1
expect_usage_error packages 0 3
expect_usage_error packages 4 3
expect_usage_error packages one 3
expect_usage_error packages 1 3 4
expect_usage_error
expect_usage_error everything
expect_usage_error api
expect_usage_error api 1
expect_usage_error api 0 4
expect_usage_error api 5 4
expect_usage_error api one 4
expect_usage_error api 1 4x
expect_usage_error web 1 2 3
expect_usage_error packages extra

# --- A test:cov list without the sharded suites is refused. ---
mkdir -p "$fixture/repo/scripts"
cp "$shard_script" "$fixture/repo/scripts/ci-test-shard.sh"
printf '%s\n' '{"scripts":{"test:cov":"pnpm --filter @squad/web --filter @squad/db exec vitest run --coverage"}}' \
  >"$fixture/repo/package.json"
CI_TEST_SHARD_DRY_RUN=1 bash "$fixture/repo/scripts/ci-test-shard.sh" packages >/dev/null 2>&1
[ $? -eq 2 ] || fail 'a test:cov list without @squad/api does not exit 2'

# --- The commands handed to pnpm. ---
mkdir -p "$fixture/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >> "$PNPM_STUB_LOG"' \
  'case " $* " in *" --filter $PNPM_STUB_FAIL "*) exit 1 ;; esac' \
  'exit 0' \
  >"$fixture/bin/pnpm"
chmod +x "$fixture/bin/pnpm"

run_stubbed() {
  : >"$fixture/pnpm.log"
  PATH="$fixture/bin:$PATH" PNPM_STUB_LOG="$fixture/pnpm.log" PNPM_STUB_FAIL="${STUB_FAIL:-none}" \
    bash "$shard_script" "$@" >"$fixture/out.log" 2>&1
}

sharded_args() {
  printf -- '--filter %s exec vitest run --shard=%s/%s --reporter=default --reporter=blob' "$1" "$2" "$3"
  printf -- ' --outputFile.blob=.vitest-reports/blob-%s-%s.json --coverage' "$2" "$3"
  printf -- ' --coverage.thresholds.lines=0 --coverage.thresholds.functions=0'
  printf -- ' --coverage.thresholds.branches=0 --coverage.thresholds.statements=0\n'
}

run_stubbed api 3 4 || fail "api shard 3/4 failed with a passing pnpm: $(cat "$fixture/out.log")"
[ "$(cat "$fixture/pnpm.log")" = "$(sharded_args @squad/api 3 4)" ] ||
  fail "api shard 3/4 ran '$(cat "$fixture/pnpm.log")'"
run_stubbed web 1 2 || fail 'web shard 1/2 failed with a passing pnpm'
[ "$(cat "$fixture/pnpm.log")" = "$(sharded_args @squad/web 1 2)" ] ||
  fail "web shard 1/2 ran '$(cat "$fixture/pnpm.log")'"
STUB_FAIL=@squad/api run_stubbed api 1 4 && fail 'a failing api shard exits 0'

# A local shard run must leave the working tree clean, or the pre-push and
# verify-done checks see the blob reports as stray files.
for blob in apps/api/.vitest-reports/blob-3-4.json apps/web/.vitest-reports/blob-1-2.json; do
  (cd "$repo_root" && git check-ignore -q --no-index "$blob") || fail "$blob is not git-ignored"
done

# One package at a time makes the start order observable.
PNPM_WORKSPACE_CONCURRENCY=1 run_stubbed packages || fail "packages slice failed with a passing pnpm: $(cat "$fixture/out.log")"
started=$(sed -n 's/^--filter \([^ ]*\) exec vitest run --coverage$/\1/p' "$fixture/pnpm.log")
[ "$started" = "$packages" ] || fail "packages slice ran:
$(cat "$fixture/pnpm.log")"
[ "$(wc -l <"$fixture/pnpm.log")" -eq "$(printf '%s\n' "$packages" | wc -l)" ] ||
  fail 'packages slice ran a package with unexpected arguments'

# Every passed package logs its duration and lands in the closing list that is
# pasted into the WEIGHTS table.
[ "$(grep -c '^ci-test-shard: .* passed in [0-9]*s$' "$fixture/out.log")" -eq "$(printf '%s\n' "$packages" | wc -l)" ] ||
  fail 'a passed package does not log its duration'
grep -Fxq 'ci-test-shard: measured seconds, ready for the WEIGHTS table:' "$fixture/out.log" ||
  fail 'the run does not end with the measured-seconds list'
[ "$(sed -n 's/^  \(.*\)=[0-9][0-9]*$/\1/p' "$fixture/out.log" | sort)" = "$(printf '%s\n' "$packages" | sort)" ] ||
  fail 'the measured-seconds list does not name every package once'

# A sharded slice runs only its own packages.
PNPM_WORKSPACE_CONCURRENCY=1 run_stubbed packages 2 3 || fail 'packages shard 2/3 failed with a passing pnpm'
started=$(sed -n 's/^--filter \([^ ]*\) exec vitest run --coverage$/\1/p' "$fixture/pnpm.log")
[ "$started" = "$(dry packages 2 3)" ] || fail "packages shard 2/3 ran:
$(cat "$fixture/pnpm.log")"

# A failure fails the slice, names the package, and still runs every other one.
STUB_FAIL=@squad/diag PNPM_WORKSPACE_CONCURRENCY=3 run_stubbed packages &&
  fail 'a failing package does not fail the packages slice'
[ "$(wc -l <"$fixture/pnpm.log")" -eq "$(printf '%s\n' "$packages" | wc -l)" ] ||
  fail 'a failing package stops the remaining packages from running'
grep -Fxq '  - @squad/diag' "$fixture/out.log" || fail 'the failed package is not named'

PNPM_WORKSPACE_CONCURRENCY=0 run_stubbed packages
[ $? -eq 2 ] || fail 'a zero PNPM_WORKSPACE_CONCURRENCY does not exit 2'

echo "test-ci-test-shard: OK — api, web and $(printf '%s\n' "$packages" | wc -l | tr -d ' ') other packages cover test:cov exactly"
