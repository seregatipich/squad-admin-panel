#!/usr/bin/env bash
# test-cov-complete.sh — fail if a workspace package's vitest suite is not run by
# `pnpm test:cov`.
#
# `test:cov` carries a hand-written `--filter` list, and CI's only JS test step
# runs it. A package added without being appended to that list therefore never
# runs in CI: it can be merged with a red suite while `dev` stays green. That is
# how `worker-scheduler` and `worker-config-sync` sat broken behind a green
# dashboard (#229) — 16 of 28 suites were invisible.
#
# This check keeps the list honest. When it fails, add the named package(s) to
# the `test:cov` filter list in the root package.json.
#
# Exit 0 = every vitest package is covered; exit 1 = at least one is missing.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

cov_line=$(node -e "process.stdout.write(require('./package.json').scripts['test:cov'] ?? '')")
if [ -z "$cov_line" ]; then
  echo "test-cov-complete: no test:cov script in package.json" >&2
  exit 1
fi

missing=()
checked=0

while IFS= read -r manifest; do
  read -r name uses_vitest <<<"$(node -e "
    const p = require('$repo_root/$manifest');
    const t = (p.scripts && p.scripts.test) || '';
    process.stdout.write((p.name || '') + ' ' + (/vitest/.test(t) ? 'yes' : 'no'));
  " 2>/dev/null)"
  [ "${uses_vitest:-no}" = yes ] || continue
  checked=$((checked + 1))
  case "$cov_line" in
  *"--filter $name "*) ;;
  *) missing+=("$name") ;;
  esac
done < <(find apps packages -maxdepth 3 -name package.json -not -path '*/node_modules/*' | sort)

if [ "$checked" -eq 0 ]; then
  echo "test-cov-complete: found no vitest packages — the scan is broken" >&2
  exit 1
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "test-cov-complete: FAIL — ${#missing[@]} vitest package(s) are not in test:cov:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  echo "" >&2
  echo "CI would never run their tests. Add each as '--filter <name>' to the" >&2
  echo "test:cov script in package.json." >&2
  exit 1
fi

echo "test-cov-complete: OK — all $checked vitest packages are covered by test:cov"
