#!/usr/bin/env bash
# Deploy the current working tree to the tk104 dev stand, straight from a
# developer workstation: no commit, no push, no GitHub Actions.
#
# tk104 is the development stand, and every push to `dev` already deploys
# there on its own: the deploy-tk104 workflow builds the images and hands their
# digests to scripts/tk104-deploy-entry.sh on the host, without running tests.
# This script is the tighter loop for work that is not even committed yet: it
# rsyncs the working tree into the same directory and compose project, builds
# ONE service's image on the host through compose.tk104.build.yml, and
# restarts just that container. Every other service keeps the images recorded
# in .release.env.
#
# What tk104 serves afterwards is NOT a pushed revision: the image is tagged
# `dev-<sha>` (plus `-dirty`), and an api preview reports that stamp on
# /health. The preview image is written into .release.env, so the next push to
# dev sees the difference and replaces it like any other change.
#
#   scripts/dev-deploy-tk104.sh              # web only (default)
#   scripts/dev-deploy-tk104.sh api          # api only, no migrations
#   scripts/dev-deploy-tk104.sh worker-rcon  # one worker only
#   CONFIRM_FULL_DEPLOY=deploy scripts/dev-deploy-tk104.sh full
#
# `full` runs scripts/deploy-tk104.sh with DEPLOY_BUILD=1: every image is built
# on the host and migrations from the working tree are applied to the tk104
# database, so it refuses to start without the explicit confirmation above.
set -euo pipefail

TARGET="${1:-web}"
SSH_TARGET="${TK104_SSH_TARGET:-seregatipich@tk104.duckdns.org}"
REMOTE_DIR="${TK104_APP_DIR:-apps/squad-admin-panel}"
SOURCE_DIR="${SOURCE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
IMAGE_REPO="${PANEL_IMAGE_REPO:-ghcr.io/seregatipich/squad-panel}"
# .env.tk104 holds the secrets and .release.env the running release, whose
# images every service except the rebuilt one keeps (Compose 2.17+ on tk104,
# which deploy-tk104.sh checks before it records a release).
COMPOSE="docker compose --env-file .env.tk104 --env-file .release.env -f compose.tk104.yml"
COMPOSE_BUILD="$COMPOSE -f compose.tk104.build.yml"

usage() {
  echo "usage: ${BASH_SOURCE[0]##*/} [web|api|worker-<name>|full]" >&2
  exit 2
}

case "$TARGET" in
  web) image_key=WEB_IMAGE image_name=web ;;
  api) image_key=API_IMAGE image_name=api ;;
  worker-*)
    # Matched by shape rather than listed service by service — the compose
    # file gains workers regularly, and a list here would go stale silently.
    # The name is interpolated into the remote command, hence the strict shape.
    [[ "$TARGET" =~ ^worker-[a-z0-9-]+$ ]] || usage
    image_key=WORKERS_IMAGE image_name=workers
    ;;
  full) ;;
  *) usage ;;
esac

if [[ "$TARGET" == "full" && "${CONFIRM_FULL_DEPLOY:-}" != "deploy" ]]; then
  echo "refusing: 'full' applies migrations from the working tree to the tk104 database." >&2
  echo "Re-run with CONFIRM_FULL_DEPLOY=deploy if that is really what you want." >&2
  exit 1
fi
if [[ ! "$IMAGE_REPO" =~ ^[a-z0-9][a-z0-9._/-]*$ ]]; then
  echo "fatal: PANEL_IMAGE_REPO must be a plain image repository (got '${IMAGE_REPO}')" >&2
  exit 2
fi

# The stamp is what tells /health that tk104 is running unpushed code. A
# pushed deploy reports a 40-hex SHA; this one can never be mistaken for it.
revision="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null)" ]]; then
  revision="${revision}-dirty"
fi
version="dev-${revision//[^A-Za-z0-9._-]/}"

if [[ "$TARGET" == "full" ]]; then
  REMOTE_CMD="DEPLOY_BUILD=1 RELEASE_SHA='${version}' bash scripts/deploy-tk104.sh"
else
  # No migrator, no --remove-orphans: exactly one container is replaced, so a
  # half-finished schema change cannot reach the tk104 database from here.
  # The exported image (and, for the api, version) overrides .release.env for
  # this one service; sed then records it so the next deploy sees a difference
  # and puts the pushed image back. For a worker the record names the preview
  # image for every worker although only this one runs it; that deploy still
  # recreates just the containers whose image differs.
  image="${IMAGE_REPO}-${image_name}:${version}"
  overrides="${image_key}='${image}'"
  record="-e 's|^${image_key}=.*|${image_key}=${image}|'"
  if [[ "$TARGET" == "api" ]]; then
    overrides+=" APP_VERSION='${version}'"
    record+=" -e 's|^APP_VERSION=.*|APP_VERSION=${version}|'"
  fi
  REMOTE_CMD="test -f .release.env || { echo 'fatal: tk104 has no release recorded yet; push to dev first' >&2; exit 1; }; export ${overrides}; ${COMPOSE_BUILD} build ${TARGET}; ${COMPOSE} up -d --no-deps ${TARGET}; sed -i ${record} .release.env"
fi

echo "==> Syncing the working tree to ${SSH_TARGET}:~/${REMOTE_DIR}/ (${version})"
# Same exclusions as tk104-deploy-entry.sh: host secrets (.env*), the release
# records (.release*), state (data) and build output stay on tk104; --delete
# keeps the remote tree identical to this one.
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'data' --exclude 'dist' --exclude '.env' --exclude '.env.*' \
  --exclude '.release*' \
  -e "ssh -o StrictHostKeyChecking=yes -o ConnectTimeout=20" \
  "${SOURCE_DIR}/" "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Rebuilding '${TARGET}' on tk104"
ssh -o StrictHostKeyChecking=yes -o ConnectTimeout=20 "$SSH_TARGET" \
  "set -euo pipefail; cd '${REMOTE_DIR}'; ${REMOTE_CMD}"

# `/health` is served by the api container, so it keeps reporting whatever the
# api was built from — a web-only deploy deliberately does not change it.
#
# Retry rather than probe once: a rebuilt api answers 502 through Caddy for a
# few seconds while it boots, and a single-shot probe would fail the deploy it
# exists to verify.
echo "==> External health probe (reports the api's revision)"
probe_status=0
for _ in $(seq 1 20); do
  probe_status=0
  curl -fsS https://tk104.duckdns.org/health --max-time 20 || probe_status=$?
  [[ "$probe_status" -eq 0 ]] && break
  sleep 3
done
echo
if [[ "$probe_status" -ne 0 ]]; then
  echo "fatal: https://tk104.duckdns.org/health never recovered (curl exit $probe_status)" >&2
  exit "$probe_status"
fi
echo "==> Done. tk104 runs ${version} in '${TARGET}' — not a pushed revision; the next push to dev replaces it."
