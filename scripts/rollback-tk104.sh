#!/usr/bin/env bash
# Return tk104 to the release that ran before the current one. Runs ON tk104
# from the app directory.
#
# Rollback starts the previous release's images, which deploy-tk104.sh keeps
# loaded, so nothing is built or downloaded. It does not undo migrations: the
# previous release runs against the current schema, which is why every
# migration must stay compatible with the release before it (CLAUDE.md).
#
# Environment:
#   ROLLBACK_TO  a specific loaded tag instead of the one in .release.prev
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
cd "$APP_DIR"

target="${ROLLBACK_TO:-$(cat .release.prev 2>/dev/null || true)}"
current="$(cat .release 2>/dev/null || true)"
if [[ -z "$target" ]]; then
  echo "fatal: no previous release recorded in $APP_DIR/.release.prev (set ROLLBACK_TO=<tag>)" >&2
  exit 1
fi
if [[ "$target" == "$current" ]]; then
  echo "fatal: ${target} is already the running release" >&2
  exit 1
fi

echo "==> Rolling back ${current:-unknown} -> ${target}"
PANEL_IMAGE_TAG="$target" APP_VERSION="$target" bash scripts/deploy-tk104.sh
