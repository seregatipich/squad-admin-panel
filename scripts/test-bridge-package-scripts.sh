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

echo "bridge-package-scripts: $PASS pass, $FAIL fail"
[ "$FAIL" -eq 0 ]
