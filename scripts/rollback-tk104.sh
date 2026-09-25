#!/usr/bin/env bash
# Return tk104 to the release that ran before the current one. Runs ON tk104
# from the app directory.
#
# The previous release's images are recorded in .release.prev.env. This hands
# them to deploy-tk104.sh, which pulls any the host no longer has from ghcr.io,
# recreates only the services that differ, waits for them, and then swaps the
# two release files, so running it twice returns to where you started. It
# does not undo migrations: the previous release runs against the current
# schema, which is why every migration must stay compatible with the release
# before it (CLAUDE.md). The compose file and Caddyfile stay those of the
# synced tree.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
PREVIOUS_FILE=".release.prev.env"
cd "$APP_DIR"

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

# Prints KEY's value from a release file, or nothing (FILE KEY).
release_value() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

if [[ ! -f "$PREVIOUS_FILE" ]]; then
  fatal "no previous release recorded in $APP_DIR/$PREVIOUS_FILE"
fi
for key in RELEASE_SHA API_IMAGE WEB_IMAGE WORKERS_IMAGE CADDY_IMAGE; do
  [[ -n "$(release_value "$PREVIOUS_FILE" "$key")" ]] || fatal "$PREVIOUS_FILE records no $key"
done
target="$(release_value "$PREVIOUS_FILE" RELEASE_SHA)"
current="$(release_value .release.env RELEASE_SHA)"
if [[ "$target" == "$current" ]]; then
  fatal "${target} is already the running release"
fi

echo "==> Rolling back ${current:-unknown} -> ${target}"
exec env -u DEPLOY_BUILD \
  APP_DIR="$APP_DIR" \
  RELEASE_SHA="$target" \
  API_IMAGE="$(release_value "$PREVIOUS_FILE" API_IMAGE)" \
  WEB_IMAGE="$(release_value "$PREVIOUS_FILE" WEB_IMAGE)" \
  WORKERS_IMAGE="$(release_value "$PREVIOUS_FILE" WORKERS_IMAGE)" \
  CADDY_IMAGE="$(release_value "$PREVIOUS_FILE" CADDY_IMAGE)" \
  bash scripts/deploy-tk104.sh
