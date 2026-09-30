#!/usr/bin/env bash
# test-rnsquadjs-runtime-copy.sh — regression guard for audit finding 1039
# (#75): the rnsquadjs sidecar runs third-party code with --network host, so its
# runtime stage must carry only what upstream executes (lib/, node_modules/,
# package.json) and never the whole build tree (.git history, sources, test
# fixtures, build tooling).
# Run locally or in CI: `bash scripts/test-rnsquadjs-runtime-copy.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
DOCKERFILE="$SRC/docker/rnsquadjs.Dockerfile"

PASS=0
FAIL=0

assert() {
  local expected=$1 desc=$2 got=$3
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got"
  fi
}

runtime_copies=$(awk '/AS runtime/{r=1} r && /^COPY --from=upstream/{print $3}' "$DOCKERFILE")

got=absent
printf '%s\n' "$runtime_copies" | grep -qx '/src' && got=present
assert absent "runtime stage does not copy the whole upstream /src tree" "$got"

for path in /src/lib /src/node_modules /src/package.json; do
  got=absent
  printf '%s\n' "$runtime_copies" | grep -qx "$path" && got=present
  assert present "runtime stage copies $path" "$got"
done

echo
echo "rnsquadjs-runtime-copy tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
