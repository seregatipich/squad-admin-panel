#!/usr/bin/env bash
# test-ci-test-shard.sh — the CI test slices together run exactly the `test:cov`
# package list: no package is dropped, none runs twice, and an unknown slice
# fails instead of silently running nothing.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
shard_script="$repo_root/scripts/ci-test-shard.sh"

fail() {
  echo "test-ci-test-shard: FAIL — $1" >&2
  exit 1
}

slice() {
  CI_TEST_SHARD_DRY_RUN=1 bash "$shard_script" "$1"
}

expected=$(cd "$repo_root" && node -e "process.stdout.write(require('./package.json').scripts['test:cov'] ?? '')" |
  grep -oE -- '--filter [^ ]+' | cut -d' ' -f2 | sort)
[ -n "$expected" ] || fail 'test:cov lists no packages'

api=$(slice api) || fail 'api slice exited non-zero'
web=$(slice web) || fail 'web slice exited non-zero'
packages=$(slice packages) || fail 'packages slice exited non-zero'

[ "$api" = '@squad/api' ] || fail "api slice selected '$api'"
[ "$web" = '@squad/web' ] || fail "web slice selected '$web'"
if printf '%s\n' "$packages" | grep -Eqx '@squad/(api|web)'; then
  fail 'packages slice repeats the api or web suite'
fi

combined=$(printf '%s\n%s\n%s\n' "$api" "$web" "$packages" | sort)
[ "$combined" = "$expected" ] || fail "slices do not add up to test:cov:
$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$combined"))"
[ "$(printf '%s\n' "$combined" | uniq -d)" = '' ] || fail 'a package appears in two slices'

CI_TEST_SHARD_DRY_RUN=1 bash "$shard_script" everything >/dev/null 2>&1
[ $? -eq 2 ] || fail 'an unknown slice does not exit 2'
CI_TEST_SHARD_DRY_RUN=1 bash "$shard_script" >/dev/null 2>&1
[ $? -eq 2 ] || fail 'a missing slice does not exit 2'

echo "test-ci-test-shard: OK — api, web and $(printf '%s\n' "$packages" | wc -l | tr -d ' ') other packages cover test:cov exactly"
