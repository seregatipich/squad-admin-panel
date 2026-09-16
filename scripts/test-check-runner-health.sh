#!/usr/bin/env bash
# test-check-runner-health.sh — test suite for scripts/check-runner-health.sh.
#
# Stubs `gh` via PATH to emit canned `gh repo view` / `gh api .../actions/runners`
# output, keyed by RH_STUB_MODE, and asserts the script's pass/fail verdict for
# every repository-level runner scenario: one runner online, all offline, none
# registered, and a failed query. The script must never consult an
# organization endpoint — the repository belongs to a personal account.
# Run: `bash scripts/test-check-runner-health.sh`.

set -u

SRC=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-runner-health-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

assert() {
  local expected=$1 desc=$2 out rc got
  out=$(RH_STUB_MODE=$RH_STUB_MODE bash "$SRC/check-runner-health.sh" 2>&1)
  rc=$?
  got=pass
  [ $rc -ne 0 ] && got=fail
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got (rc=$rc)"
    printf '%s\n' "$out" | sed 's/^/      | /'
  fi
}

# --- gh stub: canned `gh repo view` / `gh api .../actions/runners` output,
# mode via RH_STUB_MODE ------------------------------------------------------
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'EOF'
#!/bin/sh
case "$1 $2" in
"repo view")
  echo "stub-org/stub-repo"
  ;;
"api repos/"*"/actions/runners")
  case "${RH_STUB_MODE:-online}" in
  online)
    echo '{"total_count":2,"runners":[{"name":"tk104-runner-1","status":"online","busy":false},{"name":"tk104-runner-2","status":"offline","busy":false}]}'
    ;;
  offline)
    echo '{"total_count":2,"runners":[{"name":"tk104-runner-1","status":"offline","busy":false},{"name":"tk104-runner-2","status":"offline","busy":false}]}'
    ;;
  no-runner-found)
    echo '{"total_count":0,"runners":[]}'
    ;;
  repo-error)
    echo '{"message":"not found"}' >&2
    exit 1
    ;;
  esac
  ;;
"api orgs/"*)
  echo "unexpected organization query: $*" >&2
  exit 99
  ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

RH_STUB_MODE=online assert pass "repository-level runner is online"
RH_STUB_MODE=offline assert fail "repository-level runners are all offline"
RH_STUB_MODE=no-runner-found assert fail "no runner is registered on the repository"
RH_STUB_MODE=repo-error assert fail "repository-level runner query fails outright"

echo
echo "check-runner-health tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
