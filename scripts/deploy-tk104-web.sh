#!/usr/bin/env bash
# Restart ONLY the web (frontend) container on tk104 — a preview deploy from
# `dev` after CI passes, sharing the same compose project as deploy-tk104.sh's
# full-stack production deploy. api/workers/postgres/redis are left running
# whatever deploy-tk104.sh last deployed from master; only the `web` service
# picks up dev's code. Idempotent: safe to re-run. Runs ON tk104 from the app
# directory, with .env.tk104 present.
#
# Environment:
#   PANEL_IMAGE_TAG  required — tag of the loaded squad-panel/web image
#   DEPLOY_BUILD=1   build that web image on this host first (dev-deploy-tk104.sh)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
COMPOSE_FILE="compose.tk104.yml"
BUILD_FILE="compose.tk104.build.yml"
ENV_FILE=".env.tk104"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "fatal: $APP_DIR/$ENV_FILE is missing (copy .env.example, fill the tk104 secrets incl. DUCKDNS_TOKEN)" >&2
  exit 1
fi
if [[ ! "${PANEL_IMAGE_TAG:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "fatal: PANEL_IMAGE_TAG must name the web image (got '${PANEL_IMAGE_TAG:-}')" >&2
  exit 1
fi
export PANEL_IMAGE_TAG

if [[ "${DEPLOY_BUILD:-}" == 1 ]]; then
  echo "==> Building web image ${PANEL_IMAGE_TAG} (dev preview)"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$BUILD_FILE" build web
fi
if ! docker image inspect "squad-panel/web:${PANEL_IMAGE_TAG}" >/dev/null 2>&1; then
  echo "fatal: squad-panel/web:${PANEL_IMAGE_TAG} is not loaded (or set DEPLOY_BUILD=1)" >&2
  exit 1
fi

echo "==> Restarting web only — api/workers/postgres/redis are untouched"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps web

echo "==> Waiting for the web container to report running"
for _ in $(seq 1 40); do
  state="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="web"{print $2}')"
  [[ "$state" == "running" ]] && break
  sleep 3
done

echo "==> Local health probe (through Caddy on 443)"
# Caddy serves TLS only for the tk104.duckdns.org SNI (DNS-01 cert), so probe
# 127.0.0.1 with the real host name via --resolve instead of https://localhost.
curl -sk --resolve tk104.duckdns.org:443:127.0.0.1 https://tk104.duckdns.org/health \
  -o /dev/null -w 'caddy->api /health: %{http_code}\n' --max-time 10 || true

echo "==> Container status"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps web
echo "==> web (dev preview) redeploy complete."
