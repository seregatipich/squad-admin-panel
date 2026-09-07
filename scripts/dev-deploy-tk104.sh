#!/usr/bin/env bash
# Fast deploy of the current working tree to tk104, straight from a developer
# workstation and without GitHub Actions.
#
# The `deploy-tk104` workflow is the release path and stays the release path:
# it deploys reviewed `master` code from the organization runner. But it costs
# a full CI run plus a queue on a runner group with one machine in it, which is
# 30–40 minutes before a one-line UI change is visible. This script is the
# inner loop: rsync the working tree to the same directory and the same compose
# project the workflow uses, then rebuild ONE service on the host. Typically
# under three minutes, and the target is still tk104 — nothing runs locally.
#
# Because it ships whatever is in the working tree, including uncommitted work,
# what tk104 serves afterwards is NOT a released revision: `/health` reports
# `dev-<sha>` (plus `-dirty`) instead of a 40-character commit SHA. The next
# `master` deploy overwrites it. Land the change through dev → master as usual.
#
#   scripts/dev-deploy-tk104.sh          # web only (default)
#   scripts/dev-deploy-tk104.sh api      # api only, no migrations
#   CONFIRM_FULL_DEPLOY=deploy scripts/dev-deploy-tk104.sh full
#
# `full` runs `scripts/deploy-tk104.sh`, which applies database migrations from
# unreviewed code to the production database, so it refuses to start without
# the explicit confirmation above.
set -euo pipefail

TARGET="${1:-web}"
SSH_TARGET="${TK104_SSH_TARGET:-seregatipich@tk104.duckdns.org}"
REMOTE_DIR="${TK104_APP_DIR:-apps/squad-admin-panel}"
SOURCE_DIR="${SOURCE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE="docker compose --env-file .env.tk104 -f compose.tk104.yml"

case "$TARGET" in
  web)
    REMOTE_CMD="bash scripts/deploy-tk104-web.sh"
    ;;
  api)
    # No migrator, no --remove-orphans: only the api container is replaced, so
    # a half-finished schema change cannot reach the production database here.
    REMOTE_CMD="$COMPOSE build api && $COMPOSE up -d --no-deps api"
    ;;
  full)
    REMOTE_CMD="bash scripts/deploy-tk104.sh"
    ;;
  *)
    echo "usage: ${BASH_SOURCE[0]##*/} [web|api|full]" >&2
    exit 2
    ;;
esac

if [[ "$TARGET" == "full" && "${CONFIRM_FULL_DEPLOY:-}" != "deploy" ]]; then
  echo "refusing: 'full' applies migrations from the working tree to the production database." >&2
  echo "Re-run with CONFIRM_FULL_DEPLOY=deploy if that is really what you want." >&2
  exit 1
fi

# The stamp is what tells /health that tk104 is running unreleased code. A
# released deploy writes a 40-hex SHA; this one can never be mistaken for it.
revision="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null)" ]]; then
  revision="${revision}-dirty"
fi
version="dev-${revision//[^A-Za-z0-9._-]/}"

echo "==> Syncing the working tree to ${SSH_TARGET}:~/${REMOTE_DIR}/ (${version})"
# Same exclusions as the workflow: host secrets (.env*), state (data) and build
# output stay on tk104; --delete keeps the remote tree identical to this one.
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'data' --exclude 'dist' --exclude '.env' --exclude '.env.*' \
  -e "ssh -o StrictHostKeyChecking=yes -o ConnectTimeout=20" \
  "${SOURCE_DIR}/" "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Rebuilding '${TARGET}' on tk104"
ssh -o StrictHostKeyChecking=yes -o ConnectTimeout=20 "$SSH_TARGET" \
  "set -euo pipefail; cd '${REMOTE_DIR}'; export APP_VERSION='${version}'; ${REMOTE_CMD}"

echo "==> External health probe"
curl -fsS https://tk104.duckdns.org/health --max-time 20
echo
echo "==> Done. tk104 is serving ${version} — not a released revision."
