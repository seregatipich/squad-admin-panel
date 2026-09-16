#!/usr/bin/env bash
# check-runner-health.sh — report whether at least one self-hosted Actions
# deployment runner is online for this repository, so an agent can fail fast
# instead of waiting indefinitely on a queued production deployment (see
# docs/development/agent-harness.md "CI and deployment runners"). Hosted CI
# does not depend on this check.
#
# Queries the repository-level runner list (`gh api
# repos/<owner>/<repo>/actions/runners`). The repository belongs to a personal
# account, so there is no organization-level runner to fall back to: a runner
# is either registered on the repository or it does not exist.
#
# Exit 0 = at least one runner confirmed online.
# Exit 1 = no runner confirmed online — offline, none registered, or the query
#          failed. Do not expect a self-hosted deployment to execute; see
#          "Runner recovery runbook" in docs/development/agent-harness.md.
# Requires: gh (authenticated), jq.

set -u

for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "check-runner-health: required tool '$tool' is not installed" >&2
    exit 1
  }
done

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$REPO" ]; then
  echo "check-runner-health: 'gh repo view' failed — is gh authenticated? (gh auth status)" >&2
  exit 1
fi

# Prints "  <name>: status=<status> busy=<busy>" for every runner in $2 and
# returns 0 if at least one has status "online", 1 otherwise (including when
# $2 reports zero runners).
report_runners() {
  local scope=$1 json=$2 total
  total=$(printf '%s' "$json" | jq -r '.total_count // 0' 2>/dev/null)
  if [ "${total:-0}" -eq 0 ] 2>/dev/null; then
    echo "check-runner-health: $scope reports 0 runners"
    return 1
  fi
  printf '%s' "$json" | jq -r '.runners[] | "  \(.name): status=\(.status) busy=\(.busy)"'
  printf '%s' "$json" | jq -e '[.runners[] | select(.status == "online")] | length > 0' >/dev/null
}

repo_json=$(gh api "repos/$REPO/actions/runners" 2>/dev/null)
repo_rc=$?
if [ $repo_rc -eq 0 ]; then
  echo "check-runner-health: repository-level runners ($REPO):"
  if report_runners "repository" "$repo_json"; then
    echo "check-runner-health: OK — at least one runner is online"
    exit 0
  fi
else
  echo "check-runner-health: repository-level runner query failed (missing access or network error)"
fi

echo "check-runner-health: FAIL — no self-hosted runner confirmed online for $REPO." >&2
echo "check-runner-health: production deploys will queue indefinitely; see 'Runner recovery runbook' in docs/development/agent-harness.md." >&2
exit 1
