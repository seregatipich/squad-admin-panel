#!/usr/bin/env bash
# The one command the tk104 deploy key can run. Installed on tk104 as
# ~/bin/panel-deploy and bound to the key in ~/.ssh/authorized_keys:
#
#   restrict,command="$HOME/bin/panel-deploy" ssh-ed25519 AAAA… deploy-tk104
#
# sshd then runs this script whatever command the client asked for, and hands
# that request over in SSH_ORIGINAL_COMMAND (run by hand, pass it as
# arguments). The request must be exactly
#
#   deploy <40-hex commit> api=sha256:<64 hex> web=sha256:<64 hex> workers=sha256:<64 hex> caddy-tk104=sha256:<64 hex>
#
# and anything else is refused before git, rsync or Docker run: the key can
# deploy a commit of the public repository with images from our registry
# namespace, and nothing more. The accepted request fetches that commit into
# PANEL_SRC_DIR, syncs it into the app directory and hands over to
# scripts/deploy-tk104.sh from that same commit.
#
# Environment (for a manual run; sshd passes none of these to a forced command):
#   PANEL_SRC_DIR     release checkout (default ~/apps/squad-admin-panel-src)
#   PANEL_APP_DIR     compose project directory (default ~/apps/squad-admin-panel)
#   PANEL_REPO_URL    default https://github.com/seregatipich/squad-admin-panel.git
#   PANEL_IMAGE_REPO  default ghcr.io/seregatipich/squad-panel
set -euo pipefail

src_dir="${PANEL_SRC_DIR:-$HOME/apps/squad-admin-panel-src}"
app_dir="${PANEL_APP_DIR:-$HOME/apps/squad-admin-panel}"
repo_url="${PANEL_REPO_URL:-https://github.com/seregatipich/squad-admin-panel.git}"
image_repo="${PANEL_IMAGE_REPO:-ghcr.io/seregatipich/squad-panel}"

if [[ -n "${SSH_ORIGINAL_COMMAND+set}" ]]; then
  request="$SSH_ORIGINAL_COMMAND"
else
  request="$*"
fi

# Spelled-out hex digits: a range such as [a-f] can match other letters in
# some locales. The whole request is matched at once, so separators, order,
# and the absence of anything before or after are all part of the contract.
hex='[0123456789abcdef]'
digest="sha256:${hex}{64}"
pattern="^deploy (${hex}{40}) api=(${digest}) web=(${digest}) workers=(${digest}) caddy-tk104=(${digest})\$"
if [[ ! "$request" =~ $pattern ]]; then
  echo "refused: expected 'deploy <40-hex sha> api=sha256:<64-hex> web=sha256:<64-hex> workers=sha256:<64-hex> caddy-tk104=sha256:<64-hex>'" >&2
  exit 2
fi
sha="${BASH_REMATCH[1]}"
api="${BASH_REMATCH[2]}"
web="${BASH_REMATCH[3]}"
workers="${BASH_REMATCH[4]}"
caddy="${BASH_REMATCH[5]}"

echo "==> Fetching ${sha}"
if [[ ! -d "$src_dir/.git" ]]; then
  mkdir -p "$src_dir"
  git init --quiet "$src_dir"
fi
git -C "$src_dir" fetch --quiet --depth=1 --no-tags "$repo_url" "$sha"
git -C "$src_dir" -c advice.detachedHead=false checkout --quiet --force --detach "$sha"
git -C "$src_dir" clean --quiet -ffdx
head="$(git -C "$src_dir" rev-parse HEAD)"
if [[ "$head" != "$sha" ]]; then
  echo "fatal: $src_dir is at '${head}', expected ${sha}" >&2
  exit 1
fi

if ! cmp -s "${BASH_SOURCE[0]}" "$src_dir/scripts/tk104-deploy-entry.sh"; then
  echo "warning: ${BASH_SOURCE[0]} differs from scripts/tk104-deploy-entry.sh at ${sha}; reinstall it (docs/operations/deployment.md)" >&2
fi

echo "==> Syncing ${sha} into ${app_dir}"
# Same exclusions as scripts/dev-deploy-tk104.sh: host secrets (.env*), the
# release records (.release*), state (data) and build output stay on the host;
# --delete makes everything else identical to the commit.
mkdir -p "$app_dir"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  --exclude 'data' --exclude 'dist' --exclude '.env' --exclude '.env.*' \
  --exclude '.release*' \
  "$src_dir/" "$app_dir/"

cd "$app_dir"
exec env -u DEPLOY_BUILD \
  APP_DIR="$app_dir" \
  PANEL_IMAGE_REPO="$image_repo" \
  RELEASE_SHA="$sha" \
  API_IMAGE="${image_repo}-api@${api}" \
  WEB_IMAGE="${image_repo}-web@${web}" \
  WORKERS_IMAGE="${image_repo}-workers@${workers}" \
  CADDY_IMAGE="${image_repo}-caddy-tk104@${caddy}" \
  bash scripts/deploy-tk104.sh
