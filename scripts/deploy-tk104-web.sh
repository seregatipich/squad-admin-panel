#!/usr/bin/env bash
# Rebuild and restart ONLY the web (frontend) container on tk104 — a preview
# deploy from `dev` after CI passes, sharing the same compose project as
# deploy-tk104.sh's full-stack production deploy. api/workers/postgres/redis
# are left running whatever deploy-tk104.sh last deployed from master; only
# the `web` service picks up dev's code. Idempotent: safe to re-run. Runs ON
# tk104 from the app directory, with .env.tk104 present.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
COMPOSE_FILE="compose.tk104.yml"
ENV_FILE=".env.tk104"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "fatal: $APP_DIR/$ENV_FILE is missing (copy .env.example, fill the tk104 secrets incl. DUCKDNS_TOKEN)" >&2
  exit 1
fi

echo "==> Building web image (dev preview)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build web

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
