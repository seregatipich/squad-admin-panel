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

# --- Bad arguments exit 2. ---
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

# A failure fails the slice, names the package, and still runs every other one.
STUB_FAIL=@squad/diag PNPM_WORKSPACE_CONCURRENCY=3 run_stubbed packages &&
  fail 'a failing package does not fail the packages slice'
[ "$(wc -l <"$fixture/pnpm.log")" -eq "$(printf '%s\n' "$packages" | wc -l)" ] ||
  fail 'a failing package stops the remaining packages from running'
grep -Fxq '  - @squad/diag' "$fixture/out.log" || fail 'the failed package is not named'

PNPM_WORKSPACE_CONCURRENCY=0 run_stubbed packages
[ $? -eq 2 ] || fail 'a zero PNPM_WORKSPACE_CONCURRENCY does not exit 2'

echo "test-ci-test-shard: OK — api, web and $(printf '%s\n' "$packages" | wc -l | tr -d ' ') other packages cover test:cov exactly"
