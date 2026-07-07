#!/usr/bin/env bash
# apply-rulesets.sh — create or update the GitHub rulesets that back the
# agent enforcement harness (see docs/development/agent-harness.md).
#
# Reads every .github/rulesets/*.json and applies it via the GitHub API:
# a ruleset with the same name is updated in place, otherwise it is created.
# Idempotent — safe to re-run after editing a ruleset file.
#
# Requires: gh (authenticated with admin access to the repository), jq.

set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DIR=$(cd "$(dirname "$0")/../.github/rulesets" && pwd)

existing=$(gh api "repos/$REPO/rulesets" --paginate)

for file in "$DIR"/*.json; do
  name=$(jq -r .name "$file")
  id=$(printf '%s' "$existing" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -1)
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file" >/dev/null
    echo "updated ruleset '$name' (id $id) on $REPO"
  else
    gh api -X POST "repos/$REPO/rulesets" --input "$file" >/dev/null
    echo "created ruleset '$name' on $REPO"
  fi
done
