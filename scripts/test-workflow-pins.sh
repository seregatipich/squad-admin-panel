#!/usr/bin/env bash
# test-workflow-pins.sh — fail if any GitHub Actions `uses:` line references a
# mutable version tag (e.g. `@v4`) instead of an immutable commit SHA.
#
# ci.yml and deploy-tk104.yml run on the org's single, non-ephemeral
# self-hosted runner. A `uses: owner/repo@v4`-style reference resolves
# whatever commit the `v4` tag currently points to — if that repo's owner (or
# an attacker who compromises their account) repoints the tag, the next CI
# run executes arbitrary code with the runner's privileges. deploy-tk104.yml's
# `deploy` job is the highest-severity case: it checks out code and then, in
# the same job, writes the production SSH deploy key to disk (#248).
#
# This check keeps every remote `uses:` reference pinned to the 40-hex-char
# commit SHA its tag currently resolves to (with the human-readable version
# kept as a trailing `# vN` comment). Local (`./`-prefixed) and
# `docker://`-prefixed uses are exempt — they don't resolve through a mutable
# git tag the same way a remote `owner/repo@ref` does.
#
# Exit 0 = every remote `uses:` reference is SHA-pinned; exit 1 = at least one
# is not, or the scan found no pinnable `uses:` lines at all.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=()
checked=0

while IFS=: read -r file line content; do
  ref=$(printf '%s' "$content" | sed -E 's/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//')
  # Skip local actions (./path) and container-image uses (docker://...) —
  # neither names a remote repo@ref that a repointed tag could hijack.
  case "$ref" in
  ./*) continue ;;
  docker://*) continue ;;
  esac

  checked=$((checked + 1))
  sha_and_rest=${ref#*@}
  sha=${sha_and_rest%%[[:space:]]*}

  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    failures+=("$file:$line: $content")
  fi
done < <(grep -rn 'uses:' .github/workflows/*.yml)

if [ "$checked" -eq 0 ]; then
  echo "test-workflow-pins: found no pinnable 'uses:' lines — the scan is broken" >&2
  exit 1
fi

if [ ${#failures[@]} -gt 0 ]; then
  echo "test-workflow-pins: FAIL — ${#failures[@]} 'uses:' line(s) are not SHA-pinned:" >&2
  for f in "${failures[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "Pin each to the 40-hex-char commit SHA its tag currently resolves to, e.g." >&2
  echo "'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4'." >&2
  echo "Resolve via 'gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq \".object.sha, .object.type\"'" >&2
  echo "(use the tags endpoint's .commit.sha instead for annotated tags), then keep" >&2
  echo "the human-readable version as a trailing '# vN' comment." >&2
  exit 1
fi

echo "test-workflow-pins: OK — all $checked remote 'uses:' reference(s) under .github/workflows/ are SHA-pinned"
