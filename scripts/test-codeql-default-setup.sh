#!/usr/bin/env bash
# test-codeql-default-setup.sh — regression guard for issue #211: GitHub's
# default CodeQL code-scanning setup (dynamic/github-code-scanning/codeql,
# not a repo-committed workflow) can never complete on this org's Free plan
# (GHAS is not licensed — see docs/development/agent-harness.md). Guards
# against reintroducing a repo-committed CodeQL workflow that would fail the
# same way, and against the explanatory note going stale. Run locally or in
# CI: `bash scripts/test-codeql-default-setup.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
DOC="$SRC/docs/development/agent-harness.md"

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

# --- no repo-committed CodeQL workflow file -----------------------------------
got=absent
for f in "$SRC"/.github/workflows/codeql*.yml "$SRC"/.github/workflows/codeql*.yaml; do
  [ -e "$f" ] && got=present
done
assert absent "no repo-committed CodeQL workflow file (GHAS is not licensed on this Free-plan repo)" "$got"

# --- GHAS-gating note present in agent-harness.md -----------------------------
got=absent
if grep -q "CodeQL" "$DOC" && grep -q "Advanced Security" "$DOC"; then
  got=present
fi
assert present "agent-harness.md documents the CodeQL/GHAS plan-gating (issue #211)" "$got"

echo
echo "codeql-default-setup tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
