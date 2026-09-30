#!/usr/bin/env bash
# Return the stand host to the release that ran before the current one. Runs ON the stand host
# from the app directory.
#
# The previous release's images are recorded in .release.prev.env. This hands
# them to deploy-stand.sh, which pulls any the host no longer has from ghcr.io,
# recreates only the services that differ, waits for them, and then swaps the
# two release files, so running it twice returns to where you started. It
# does not undo migrations: the previous release runs against the current
# schema, which is why every migration must stay compatible with the release
# before it (CLAUDE.md). The compose file and Caddyfile stay those of the
# synced tree.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
PREVIOUS_FILE=".release.prev.env"
BAD_FILE=".release.bad.env"
cd "$APP_DIR"

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

warn() {
  echo "!! $*" >&2
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

# deploy-stand.sh unconditionally swaps .release.env -> .release.prev.env on
# every deploy, rollbacks included: once this rollback runs, .release.prev.env
# will hold the release we are rolling away from (${current}), not necessarily
# an older good one. Rolling back twice in a row is a supported, tested way to
# return to where you started — but if ${current} was actually broken, a
# THIRD run with still no explicit target would silently redeploy it again,
# since only one hop of history is kept. Warn loudly whenever the target was
# itself something this script rolled away from previously, instead of
# silently proceeding as if it were guaranteed safe.
bad="$(release_value "$BAD_FILE" RELEASE_SHA)"
if [[ -n "$bad" && "$target" == "$bad" ]]; then
  warn "${target} was rolled back away from previously (recorded in $BAD_FILE)."
  warn "If it was rolled back BECAUSE it was broken, do not proceed — deploy a fix instead."
  warn "Proceeding anyway (rollback-stand.sh only remembers one hop of release history)."
fi

echo "==> Rolling back ${current:-unknown} -> ${target}"
# Record what we are leaving so a follow-up rollback onto it gets the
# warning above instead of silently redeploying it. Written before exec
# since exec replaces this process.
if [[ -n "$current" ]]; then
  printf 'RELEASE_SHA=%s\n' "$current" >"$BAD_FILE"
fi
exec env \
  APP_DIR="$APP_DIR" \
  RELEASE_SHA="$target" \
  API_IMAGE="$(release_value "$PREVIOUS_FILE" API_IMAGE)" \
  WEB_IMAGE="$(release_value "$PREVIOUS_FILE" WEB_IMAGE)" \
  WORKERS_IMAGE="$(release_value "$PREVIOUS_FILE" WORKERS_IMAGE)" \
  CADDY_IMAGE="$(release_value "$PREVIOUS_FILE" CADDY_IMAGE)" \
  bash scripts/deploy-stand.sh
