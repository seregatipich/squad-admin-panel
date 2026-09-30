#!/usr/bin/env bash
# test-dependency-pins.sh — supply-chain pinning contract for images and the
# pnpm install policy (#48).
#
# Checks, each one a regression guard for a finding in #48:
#   1. The third-party images that handle secrets — the restic backup image
#      (POSTGRES_PASSWORD, RESTIC_PASSWORD, the full DB dump) and the Caddy
#      TLS terminator (DUCKDNS_TOKEN, certificate keys) — build FROM
#      digest-pinned bases, and every xcaddy `--with` module carries a
#      version, so a rebuild never silently picks up a new upstream.
#   2. Every `pnpm.overrides` entry in package.json is a version range, never
#      an exact version: an exact pin freezes a package at that version and
#      blocks `pnpm update`/Dependabot from picking up its next security fix.
#   3. The install-script allowlist lives where the pinned pnpm reads it.
#      pnpm 9 reads `onlyBuiltDependencies` only from package.json's `pnpm`
#      field (pnpm-workspace.yaml settings arrived in pnpm 10), so the list
#      in pnpm-workspace.yaml was inert and every dependency's install script
#      ran.
#
# Run locally or in CI: `bash scripts/test-dependency-pins.sh`. Exit 0 = all
# contracts hold; exit 1 = at least one is broken (each is listed).
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

failures=()

# --- 1. digest-pinned bases and versioned xcaddy modules --------------------
for dockerfile in docker/restic.Dockerfile docker/caddy-duckdns.Dockerfile; do
  from_lines=$(grep -nE '^[[:space:]]*FROM[[:space:]]' "$dockerfile" || true)
  if [ -z "$from_lines" ]; then
    failures+=("$dockerfile: no FROM line found")
    continue
  fi
  while IFS= read -r from_line; do
    if [[ ! "$from_line" =~ @sha256:[0-9a-f]{64}([[:space:]]|$) ]]; then
      failures+=("$dockerfile:$from_line — base image is not pinned by @sha256 digest")
    fi
  done <<<"$from_lines"
done

while IFS= read -r module; do
  [ -z "$module" ] && continue
  if [[ ! "$module" =~ @[^[:space:]]+$ ]]; then
    failures+=("docker/caddy-duckdns.Dockerfile: xcaddy module '$module' has no @version")
  fi
done < <(grep -oE -- '--with[[:space:]]+[^[:space:]\\]+' docker/caddy-duckdns.Dockerfile | awk '{print $2}')

# --- 2 + 3. pnpm overrides and install-script allowlist ---------------------
pnpm_report=$(node -e '
  const pkg = require("./package.json");
  const pnpm = pkg.pnpm ?? {};
  for (const [name, spec] of Object.entries(pnpm.overrides ?? {})) {
    if (/^\d/.test(spec)) {
      console.log(`package.json pnpm.overrides["${name}"] = "${spec}" is an exact version — use a range (e.g. ^${spec})`);
    }
  }
  if (!/^pnpm@9\./.test(pkg.packageManager ?? "")) process.exit(0);
  if (!Array.isArray(pnpm.onlyBuiltDependencies)) {
    console.log("package.json pnpm.onlyBuiltDependencies is missing — pnpm 9 reads the install-script allowlist only from there");
  }
')
while IFS= read -r line; do
  [ -n "$line" ] && failures+=("$line")
done <<<"$pnpm_report"

if grep -q '"packageManager": "pnpm@9\.' package.json &&
  grep -nE '^[[:space:]]*(onlyBuiltDependencies|neverBuiltDependencies|ignoredBuiltDependencies)[[:space:]]*:' pnpm-workspace.yaml >/dev/null; then
  failures+=("pnpm-workspace.yaml declares a build-script setting that pnpm 9 ignores — keep it in package.json's pnpm field")
fi

if [ ${#failures[@]} -gt 0 ]; then
  echo "test-dependency-pins: ${#failures[@]} contract violation(s):"
  printf '  %s\n' "${failures[@]}"
  exit 1
fi

echo "test-dependency-pins: all image, override and install-script pins hold"
