#!/usr/bin/env bash
# test-check-runner-health.sh — test suite for scripts/check-runner-health.sh.
#
# Stubs `gh` via PATH to emit canned `gh repo view` / `gh api .../actions/runners`
# output, keyed by RH_STUB_MODE, and asserts the script's pass/fail verdict for
# every runner-status scenario observed or plausible for #215 (repository-level
# online, repository-level offline, repository-level disabled with an empty
# org-level fallback, an org-level 403, a failed repository-level query rescued
# by a healthy org-level fallback, and both levels reporting zero runners).
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
  no-runner-found | 403 | org-online)
    echo '{"total_count":0,"runners":[]}'
    ;;
  repo-error)
    echo '{"message":"not found"}' >&2
    exit 1
    ;;
  esac
  ;;
"api orgs/"*"/actions/runners")
  case "${RH_STUB_MODE:-online}" in
  offline)
    echo '{"total_count":1,"runners":[{"name":"org-runner","status":"offline","busy":false}]}'
    ;;
  no-runner-found)
    echo '{"total_count":0,"runners":[]}'
    ;;
  403)
    echo '{"message":"You must be an org admin or have the runners and runner groups fine-grained permission.","status":"403"}' >&2
    exit 1
    ;;
  repo-error | org-online)
    echo '{"total_count":1,"runners":[{"name":"tk104-runner-1","status":"online","busy":false}]}'
    ;;
  esac
  ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

RH_STUB_MODE=online assert pass "repository-level runner is online"
RH_STUB_MODE=offline assert fail "repository-level runners all offline, org fallback also offline"
RH_STUB_MODE=no-runner-found assert fail "repository-level runners disabled (0 registered), org query succeeds with 0 runners"
RH_STUB_MODE=403 assert fail "repository-level runners disabled (0 registered), org query 403s"
RH_STUB_MODE=org-online assert pass "repository-level runners disabled (0 registered), org fallback reports an online runner"
RH_STUB_MODE=repo-error assert pass "repository-level query fails outright, org fallback reports an online runner"

echo
echo "check-runner-health tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
