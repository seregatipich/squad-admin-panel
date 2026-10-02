#!/usr/bin/env bash
# test-bridge-package-scripts.sh — regression guard for issue #46 (#419): the
# @squad/bridge package.json gates must skip only when `go` is absent (or the
# host is not Linux for tests) and must propagate real go failures. The old
# `A && B || echo skip` form turned a failing `go build`/`go test` into exit 0.
# A fake `go` on PATH that always fails stands in for a broken bridge build.
# Run locally or in CI: `bash scripts/test-bridge-package-scripts.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
PKG="$SRC/apps/bridge/package.json"

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

FAKE=$(mktemp -d)
trap 'rm -rf "$FAKE"' EXIT
cat >"$FAKE/go" <<'GO'
#!/bin/sh
if [ "$1" = env ]; then echo linux; exit 0; fi
exit 1
GO
chmod +x "$FAKE/go"

script() { node -e 'console.log(require(process.argv[1]).scripts[process.argv[2]])' "$PKG" "$1"; }

for name in build typecheck test lint; do
  (cd "$SRC/apps/bridge" && PATH="$FAKE:$PATH" sh -c "$(script "$name")" >/dev/null 2>&1)
  assert 1 "$name fails when go itself fails" "$([ $? -ne 0 ] && echo 1 || echo 0)"
done

# go absent from PATH: build and typecheck skip cleanly. PATH holds a directory
# with only an `sh` symlink, because hosts that link go into /usr/bin or /bin
# would still resolve it there. The scripts need nothing else (`command` and
# `echo` are shell builtins).
NOGO=$(mktemp -d)
ln -s "$(command -v sh)" "$NOGO/sh"
for name in build typecheck; do
  (cd "$SRC/apps/bridge" && PATH="$NOGO" sh -c "$(script "$name")" >/dev/null 2>&1)
  got=$?
  assert 0 "$name skips with exit 0 when go is not on PATH" "$got"
done
rm -rf "$NOGO"

# test:unit (#120): skipped with a message and exit 0 where it cannot run (no go,
# or a non-Linux go), an error under CI, and a real go failure still fails it.
NOGO=$(mktemp -d)
ln -s "$(command -v sh)" "$NOGO/sh"
(cd "$SRC/apps/bridge" && env -u CI PATH="$NOGO" sh -c "$(script test:unit)" >"$FAKE/out" 2>&1)
assert 0 "test:unit skips with exit 0 when go is not on PATH" "$?"
assert 1 "test:unit says why it skipped" "$(grep -c 'skipping test:unit: go is not on PATH' "$FAKE/out")"
(cd "$SRC/apps/bridge" && CI=true PATH="$NOGO" sh -c "$(script test:unit)" >"$FAKE/out" 2>&1)
assert 1 "test:unit fails under CI when go is not on PATH" "$([ $? -ne 0 ] && echo 1 || echo 0)"
assert 1 "test:unit explains the CI refusal" "$(grep -c 'CI is set: refusing to skip' "$FAKE/out")"
rm -rf "$NOGO"

NONLINUX=$(mktemp -d)
printf '#!/bin/sh\nif [ "$1" = env ]; then echo darwin; exit 0; fi\nexit 1\n' >"$NONLINUX/go"
chmod +x "$NONLINUX/go"
(cd "$SRC/apps/bridge" && env -u CI PATH="$NONLINUX:$PATH" sh -c "$(script test:unit)" >/dev/null 2>&1)
assert 0 "test:unit skips with exit 0 on a non-Linux go" "$?"
(cd "$SRC/apps/bridge" && CI=true PATH="$NONLINUX:$PATH" sh -c "$(script test:unit)" >/dev/null 2>&1)
assert 1 "test:unit fails under CI on a non-Linux go" "$([ $? -ne 0 ] && echo 1 || echo 0)"
rm -rf "$NONLINUX"

(cd "$SRC/apps/bridge" && env -u CI PATH="$FAKE:$PATH" sh -c "$(script test:unit)" >/dev/null 2>&1)
assert 1 "test:unit fails when go test itself fails" "$([ $? -ne 0 ] && echo 1 || echo 0)"

echo "bridge-package-scripts: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
