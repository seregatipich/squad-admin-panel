#!/usr/bin/env bash
# test-workflow-security.sh — fail if any GitHub Actions workflow combines a
# pull_request(_target) trigger with a self-hosted job.
#
# Any self-hosted workflow carries persistent machine access. A pull_request
# (or pull_request_target) trigger could execute untrusted or merely
# review-stage code there before human acceptance. CI itself is now hosted,
# but the production deploy remains self-hosted, so this invariant stays
# repository-wide and prevents an unsafe regression (#217, #286).
#
# This check keeps that invariant honest: it fails if any workflow file's
# top-level `on:` block declares pull_request or pull_request_target while
# the same file also has a job on a self-hosted runner — declared by the
# `self-hosted` label (alone, in an inline label list, or as a list item) or
# by a runner group. The detector is exercised against inline fixtures first,
# so a rewrite that stops recognising one of those forms fails here instead of
# silently passing every workflow.
#
# This is a repository-side guard only. A pull request from a fork can add its
# own workflow file, which this test never sees before it runs; that case is
# closed by the repository setting that requires approval before workflows from
# outside collaborators run (docs/development/agent-harness.md).
#
# Exit 0 = no workflow reaches a self-hosted job via pull_request(_target);
# exit 1 = at least one does, the detector misreads a fixture, or the scan
# found no workflow files at all.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

# Prints "yes" when the workflow text on stdin declares a pull_request(_target)
# trigger in its top-level `on:` block and also a job on a self-hosted runner.
# Only the `on:` block is inspected for triggers, so a `run:` body that merely
# mentions "pull_request" is not mistaken for one.
reaches_self_hosted_from_pr() {
  local text on_block has_pr_trigger=no has_self_hosted=no
  text=$(cat)
  on_block=$(printf '%s\n' "$text" | awk '
    /^on:/ { inon = 1; print; next }
    inon && /^[^[:space:]]/ { inon = 0 }
    inon { print }
  ')
  if printf '%s\n' "$on_block" | grep -Eq '^[[:space:]]+pull_request(_target)?:'; then
    has_pr_trigger=yes
  fi
  # `runs-on: self-hosted`, `runs-on: [self-hosted, label]`, and a block list
  # whose first item is `- self-hosted` all reach a persistent machine.
  if printf '%s\n' "$text" | grep -Eq '^[[:space:]]*runs-on:.*self-hosted'; then
    has_self_hosted=yes
  fi
  if printf '%s\n' "$text" | grep -A3 -E '^[[:space:]]*runs-on:[[:space:]]*$' |
    grep -Eq '^[[:space:]]*(-[[:space:]]*self-hosted|group:)'; then
    has_self_hosted=yes
  fi
  if [ "$has_pr_trigger" = yes ] && [ "$has_self_hosted" = yes ]; then
    echo yes
  else
    echo no
  fi
}

expect_detector() {
  local expected=$1 desc=$2 got
  got=$(reaches_self_hosted_from_pr)
  if [ "$got" != "$expected" ]; then
    echo "test-workflow-security: FAIL — detector self-test '$desc' returned $got instead of $expected" >&2
    exit 1
  fi
}

pr_on=$'on:\n  pull_request:\n    branches: [dev]\njobs:\n  x:\n'
push_on=$'on:\n  push:\n    branches: [dev]\njobs:\n  x:\n'
printf '%s    runs-on: self-hosted\n' "$pr_on" | expect_detector yes 'label'
printf '%s    runs-on: [self-hosted, tk104-deploy]\n' "$pr_on" | expect_detector yes 'inline label list'
printf '%s    runs-on:\n      - self-hosted\n      - tk104-deploy\n' "$pr_on" | expect_detector yes 'block label list'
printf '%s    runs-on:\n      group: selfhost-group-1\n' "$pr_on" | expect_detector yes 'runner group'
printf '%s    runs-on: [self-hosted, tk104-deploy]\n' "${pr_on/pull_request:/pull_request_target:}" | expect_detector yes 'pull_request_target'
printf '%s    runs-on: [self-hosted, tk104-deploy]\n' "$push_on" | expect_detector no 'push-only self-hosted'
printf '%s    runs-on: ubuntu-24.04\n' "$pr_on" | expect_detector no 'hosted pull request'
printf '%s    runs-on: self-hosted\n    steps:\n      - run: test "$E" = pull_request\n' "$push_on" |
  expect_detector no 'pull_request mentioned only in a run body'
printf 'concurrency:\n  group: deploy-tk104\n%s    runs-on: ubuntu-24.04\n' "$pr_on" |
  expect_detector no 'concurrency group is not a runner group'

violations=()
checked=0

while IFS= read -r workflow; do
  checked=$((checked + 1))
  if [ "$(reaches_self_hosted_from_pr <"$workflow")" = yes ]; then
    violations+=("$workflow")
  fi
done < <(find .github/workflows -maxdepth 1 -name '*.yml' | sort)

if [ "$checked" -eq 0 ]; then
  echo "test-workflow-security: no workflow files found under .github/workflows — the scan is broken" >&2
  exit 1
fi

if [ ${#violations[@]} -gt 0 ]; then
  echo "test-workflow-security: FAIL — ${#violations[@]} workflow(s) run a self-hosted job on pull_request/pull_request_target:" >&2
  for v in "${violations[@]}"; do echo "  - $v" >&2; done
  echo "" >&2
  echo "Untrusted or merely review-stage pull-request code must never execute on" >&2
  echo "the shared self-hosted runner. Remove the pull_request/pull_request_target" >&2
  echo "trigger, or move the job to a GitHub-hosted image, before merging." >&2
  exit 1
fi

echo "test-workflow-security: OK — checked $checked workflow(s), no pull_request trigger reaches a self-hosted job"
