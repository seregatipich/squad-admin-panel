#!/usr/bin/env bash
# test-runner-disk-cleanup.sh — keep the shared runner cleanup independent
# from the success of the expensive node/go/docker jobs (#281).
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
workflow="$repo_root/.github/workflows/ci.yml"

fail() {
  echo "test-runner-disk-cleanup: FAIL — $1" >&2
  exit 1
}

job_block() {
  local job=$1
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:$/ && $0 != "  " job ":" { exit }
    inside { print }
  ' "$workflow"
}

prepare=$(job_block prepare-runner)
branch_guard=$(job_block branch-guard)
node=$(job_block node)
go_job=$(job_block go)
docker_job=$(job_block docker)
cleanup=$(job_block cleanup-runner)

[ -n "$prepare" ] || fail 'prepare-runner job is missing'
[ -n "$cleanup" ] || fail 'cleanup-runner job is missing'
printf '%s\n' "$branch_guard" | grep -Fq 'bash scripts/test-runner-disk-cleanup.sh' || fail 'branch-guard does not execute this regression test'
printf '%s\n' "$node" | grep -Fq 'needs: prepare-runner' || fail 'node does not wait for prepare-runner'
printf '%s\n' "$go_job" | grep -Fq 'needs: prepare-runner' || fail 'go does not wait for prepare-runner'
printf '%s\n' "$docker_job" | grep -Fq 'needs: [node, go]' || fail 'docker no longer requires green node and go jobs'
printf '%s\n' "$cleanup" | grep -Fq 'needs: [node, go, docker]' || fail 'cleanup-runner does not observe every expensive job'
printf '%s\n' "$cleanup" | grep -Fq 'if: ${{ always() }}' || fail 'cleanup-runner is skipped after a failed dependency'

for block in "$prepare" "$cleanup"; do
  printf '%s\n' "$block" | grep -Eq 'docker image prune -f([[:space:]]|$)' || fail 'safe dangling-image cleanup is missing'
  if printf '%s\n' "$block" | grep -Eq 'docker image prune.*([[:space:]]-a([[:space:]]|$)|--all|[[:space:]]-[[:alnum:]]*a[[:alnum:]]*)'; then
    fail 'cleanup must not remove named images with docker image prune -a'
  fi
  printf '%s\n' "$block" | grep -Fq 'docker builder prune -f --filter "until=72h"' || fail 'age-bounded builder cleanup is missing'
  if printf '%s\n' "$block" | grep -Eq 'docker builder prune -f[[:space:]]*$'; then
    fail 'unbounded builder-cache cleanup is forbidden'
  fi
  printf '%s\n' "$block" | grep -Fq 'docker container prune -f' || fail 'stopped-container cleanup is missing'
  printf '%s\n' "$block" | grep -Fq 'docker volume prune -f' || fail 'orphaned-volume cleanup is missing'
done

echo 'test-runner-disk-cleanup: OK — cleanup runs before and after expensive jobs without weakening their gate'
