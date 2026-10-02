#!/usr/bin/env bash
# test-repo-contracts.sh — run every repository-contract shell suite (the
# harness, workflow, pin and policy tests) in one go. The `branch-guard` job in
# .github/workflows/ci.yml calls this instead of one step per suite; locally it
# is the way to run them all: `bash scripts/test-repo-contracts.sh`.
#
# Every suite runs even after another failed, so one run reports every broken
# contract; the failures are listed at the end and the exit status is 1 if there
# was any. The suites run in the order below. scripts/test-pre-push-checklist.sh
# needs `gitleaks` on PATH (the ci job installs it before calling this script).
#
# Environment:
#   REPO_CONTRACTS_SUITES  space-separated suite names (without `.sh`, resolved next to
#                          this script) replacing the list below; used by the tests
#
# Exit 0 = every suite passed; 1 = at least one suite failed or is missing.
set -uo pipefail

scripts_dir=$(cd "$(dirname "$0")" && pwd)
cd "$scripts_dir/.."

SUITES=(
  test-git-guard
  test-verify-done
  test-pre-push-checklist
  test-workflow-pins
  test-dependency-pins
  test-migration-lint
  test-gitignore-patterns
  test-workflow-security
  test-codeql-default-setup
  test-ci-runner-strategy
  test-ci-test-shard
  test-image-preserve-labels
  test-rnsquadjs-runtime-copy
  test-bridge-package-scripts
  test-compose-env-passthrough
  test-postgres-max-connections
  test-local-dev-isolation
  test-ci-reuse-deploy-images
)
if [ -n "${REPO_CONTRACTS_SUITES:-}" ]; then
  # shellcheck disable=SC2206
  SUITES=($REPO_CONTRACTS_SUITES)
fi

failed=()
for suite in "${SUITES[@]}"; do
  echo "=== $suite ==="
  started=$SECONDS
  if [ ! -f "$scripts_dir/$suite.sh" ]; then
    echo "test-repo-contracts: $scripts_dir/$suite.sh does not exist" >&2
    failed+=("$suite (missing)")
  elif bash "$scripts_dir/$suite.sh"; then
    echo "--- $suite passed in $((SECONDS - started))s"
  else
    echo "--- $suite FAILED after $((SECONDS - started))s" >&2
    failed+=("$suite")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "test-repo-contracts: ${#failed[@]} of ${#SUITES[@]} suite(s) failed:" >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
echo "test-repo-contracts: all ${#SUITES[@]} suites passed"
