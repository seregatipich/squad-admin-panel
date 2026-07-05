#!/usr/bin/env bash
# Deploy the squad-admin-panel core stack on tk104. Idempotent: safe to re-run.
# Runs ON tk104 from the app directory, with .env.tk104 present.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
COMPOSE_FILE="compose.tk104.yml"
ENV_FILE=".env.tk104"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "fatal: $APP_DIR/$ENV_FILE is missing (copy .env.tk104.example and fill secrets)" >&2
  exit 1
fi

echo "==> Building images"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build

echo "==> Starting stack (migrator runs migrations, then api/web/caddy)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans

echo "==> Waiting for the api to report healthy"
for _ in $(seq 1 40); do
  status="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="api"{print $2}')"
  [[ "$status" == "healthy" ]] && break
  sleep 3
done

echo "==> Local health probe (through Caddy on 443)"
curl -sk https://localhost/health -o /dev/null -w 'caddy->api /health: %{http_code}\n' --max-time 10 || true

echo "==> Container status"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
echo "==> Deploy complete. External: https://tk104.duckdns.org/"
