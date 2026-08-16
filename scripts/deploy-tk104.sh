#!/usr/bin/env bash
# Deploy the squad-admin-panel core stack on tk104. Idempotent: safe to re-run.
# Runs ON tk104 from the app directory, with .env.tk104 present.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
COMPOSE_FILE="compose.tk104.yml"
ENV_FILE=".env.tk104"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "fatal: $APP_DIR/$ENV_FILE is missing (copy .env.example, fill the tk104 secrets incl. DUCKDNS_TOKEN)" >&2
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
if [[ "$status" != "healthy" ]]; then
  echo "fatal: api did not become healthy after 120 seconds (last status: ${status:-missing})" >&2
  exit 1
fi

echo "==> Local health probe (through Caddy on 443)"
# Caddy serves TLS only for the tk104.duckdns.org SNI (DNS-01 cert), so probe
# 127.0.0.1 with the real host name via --resolve instead of https://localhost.
#
# Retry rather than probe once: the api-health wait above returns as soon as the
# api container is healthy, but caddy is started in the same `up -d` and needs a
# moment more to bind 443 and finish its TLS handshake. A single-shot probe
# therefore races the deploy it exists to verify — run 31948383567 failed with
# curl exit 35 (SSL connect error) 140 ms after "Container caddy-1 Started",
# while the stack itself was healthy and serving. Same cadence as the api wait;
# the last failure's exit code is preserved so a genuinely broken deploy still
# fails closed.
probe_status=0
for _ in $(seq 1 20); do
  probe_status=0
  curl -fsk --resolve tk104.duckdns.org:443:127.0.0.1 https://tk104.duckdns.org/health \
    -o /dev/null -w 'caddy->api /health: %{http_code}\n' --max-time 10 || probe_status=$?
  [[ "$probe_status" -eq 0 ]] && break
  sleep 3
done
if [[ "$probe_status" -ne 0 ]]; then
  echo "fatal: health probe through Caddy failed after 20 attempts (curl exit $probe_status)" >&2
  exit "$probe_status"
fi

echo "==> Container status"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
echo "==> Deploy complete. External: https://tk104.duckdns.org/"
