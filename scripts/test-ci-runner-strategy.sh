#!/usr/bin/env bash
# test-ci-runner-strategy.sh — keep verification ephemeral while production
# deployment remains isolated on the dedicated self-hosted runner (#286).
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
ci_workflow="$repo_root/.github/workflows/ci.yml"
deploy_workflow="$repo_root/.github/workflows/deploy-tk104.yml"

fail() {
  echo "test-ci-runner-strategy: FAIL — $1" >&2
  exit 1
}

job_block() {
  local workflow=$1
  local job=$2
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:$/ && $0 != "  " job ":" { exit }
    inside { print }
  ' "$workflow"
}

[ -f "$ci_workflow" ] || fail 'ci workflow is missing'
[ -f "$deploy_workflow" ] || fail 'deploy workflow is missing'

for job in branch-guard node go docker; do
  block=$(job_block "$ci_workflow" "$job")
  [ -n "$block" ] || fail "required ci job '$job' is missing"
  printf '%s\n' "$block" | grep -Fq 'runs-on: ubuntu-24.04' ||
    fail "ci job '$job' does not use the pinned GitHub-hosted Ubuntu image"
done

if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*self-hosted[[:space:]]*$' "$ci_workflow"; then
  fail 'ci still contains a self-hosted job'
fi

for obsolete_job in prepare-runner cleanup-runner; do
  if [ -n "$(job_block "$ci_workflow" "$obsolete_job")" ]; then
    fail "ephemeral ci still contains obsolete '$obsolete_job' maintenance"
  fi
done

if grep -Eq 'docker (image|builder|container|volume) prune' "$ci_workflow"; then
  fail 'ephemeral ci still mutates persistent runner disk state'
fi

go_block=$(job_block "$ci_workflow" go)
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/setup-go@[0-9a-f]{40}' ||
  fail 'go job does not install Go through a SHA-pinned setup action'
if printf '%s\n' "$go_block" | grep -Eq '^[[:space:]]+container:'; then
  fail 'go job still carries the self-hosted filesystem-isolation container'
fi

grep -Fq 'cancel-in-progress: true' "$ci_workflow" ||
  fail 'superseded ci runs still consume the monthly hosted-runner allowance'

branch_guard=$(job_block "$ci_workflow" branch-guard)
printf '%s\n' "$branch_guard" | grep -Fq 'bash scripts/test-ci-runner-strategy.sh' ||
  fail 'branch-guard does not execute this regression test'

if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*ubuntu-' "$deploy_workflow"; then
  fail 'production deploy must not move to a GitHub-hosted runner'
fi
grep -Eq '^[[:space:]]*runs-on:[[:space:]]*self-hosted[[:space:]]*$' "$deploy_workflow" ||
  fail 'production deploy no longer targets the dedicated self-hosted runner'

echo 'test-ci-runner-strategy: OK — ci is ephemeral and production deploy remains self-hosted'
