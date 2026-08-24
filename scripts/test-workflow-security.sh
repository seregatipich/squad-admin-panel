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
# the same file also has a job on a self-hosted runner — declared either by the
# `self-hosted` label or by a runner group.
#
# Exit 0 = no workflow reaches a self-hosted job via pull_request(_target);
# exit 1 = at least one does, or the scan found no workflow files at all.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

violations=()
checked=0

while IFS= read -r workflow; do
  checked=$((checked + 1))

  # Isolate the workflow-level `on:` block: from the top-level `on:` line up
  # to (not including) the next top-level key. This keeps a `run:` step body
  # that merely mentions the string "pull_request" (e.g. a shell comparison)
  # from being mistaken for an actual trigger declaration.
  on_block=$(awk '
    /^on:/ { inon = 1; print; next }
    inon && /^[^[:space:]]/ { inon = 0 }
    inon { print }
  ' "$workflow")

  has_pr_trigger=no
  if printf '%s\n' "$on_block" | grep -Eq '^[[:space:]]+pull_request(_target)?:'; then
    has_pr_trigger=yes
  fi

  # Свой раннер объявляют двумя способами, и оба дают доступ к постоянной
  # машине: меткой (`runs-on: self-hosted`) и группой (`runs-on:` + `group:`).
  # Проверять только метку нельзя — этот проект выбирает раннеры группой, и
  # такая проверка молча проходила бы на любом workflow.
  has_self_hosted=no
  if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*self-hosted[[:space:]]*$' "$workflow"; then
    has_self_hosted=yes
  fi
  if grep -Eq '^[[:space:]]*group:[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*$' "$workflow"; then
    has_self_hosted=yes
  fi

  if [ "$has_pr_trigger" = yes ] && [ "$has_self_hosted" = yes ]; then
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
  echo "trigger, or move the job off runs-on: self-hosted, before merging." >&2
  exit 1
fi

echo "test-workflow-security: OK — checked $checked workflow(s), no pull_request trigger reaches a self-hosted job"
