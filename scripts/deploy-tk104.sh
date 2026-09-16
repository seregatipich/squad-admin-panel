#!/usr/bin/env bash
# Deploy the squad-admin-panel core stack on tk104. Idempotent: safe to re-run.
# Runs ON tk104 from the app directory, with .env.tk104 present.
#
# A release does not build here. CI builds the api, web, workers and caddy
# images once and the deploy workflow loads them as
# squad-panel/<image>:<PANEL_IMAGE_TAG>; this script checks they are present,
# starts the stack on that tag, and records it. DEPLOY_BUILD=1 builds the tag
# on the host instead (scripts/dev-deploy-tk104.sh, or a manual rebuild when no
# release artifact exists).
#
# Environment:
#   PANEL_IMAGE_TAG  required — tag of the release images (a 40-hex SHA for a
#                    release, dev-<sha> for a preview)
#   APP_VERSION      reported by /health; defaults to PANEL_IMAGE_TAG
#   DEPLOY_BUILD=1   build the images on this host first
#   KEEP_RELEASES    image tags kept per repository after success (default 3)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
COMPOSE_FILE="compose.tk104.yml"
BUILD_FILE="compose.tk104.build.yml"
ENV_FILE=".env.tk104"
IMAGES=(api web workers caddy-tk104)

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "fatal: $APP_DIR/$ENV_FILE is missing (copy .env.example, fill the tk104 secrets incl. DUCKDNS_TOKEN)" >&2
  exit 1
fi
if [[ ! "${PANEL_IMAGE_TAG:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "fatal: PANEL_IMAGE_TAG must name the release images (got '${PANEL_IMAGE_TAG:-}')" >&2
  exit 1
fi
export PANEL_IMAGE_TAG
export APP_VERSION="${APP_VERSION:-$PANEL_IMAGE_TAG}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

if [[ "${DEPLOY_BUILD:-}" == 1 ]]; then
  echo "==> Building images ${PANEL_IMAGE_TAG} on this host"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$BUILD_FILE" build
fi

echo "==> Checking release images ${PANEL_IMAGE_TAG}"
for image in "${IMAGES[@]}"; do
  if ! docker image inspect "squad-panel/${image}:${PANEL_IMAGE_TAG}" >/dev/null 2>&1; then
    echo "fatal: squad-panel/${image}:${PANEL_IMAGE_TAG} is not loaded — the deploy workflow loads release images before running this script (or set DEPLOY_BUILD=1)" >&2
    exit 1
  fi
done

echo "==> Starting stack (migrator runs migrations, then api/web/caddy)"
compose up -d --remove-orphans

echo "==> Waiting for the api to report healthy"
for _ in $(seq 1 40); do
  status="$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="api"{print $2}')"
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

echo "==> Recording release ${PANEL_IMAGE_TAG}"
# .release is the running tag and .release.prev the one before it, which
# scripts/rollback-tk104.sh returns to. The env file carries the same tag so
# plain `docker compose --env-file .env.tk104 …` commands keep resolving the
# image names; a failed deploy never reaches this point and leaves both alone.
current="$(cat .release 2>/dev/null || true)"
if [[ -n "$current" && "$current" != "$PANEL_IMAGE_TAG" ]]; then
  printf '%s\n' "$current" > .release.prev
fi
printf '%s\n' "$PANEL_IMAGE_TAG" > .release
env_tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
chmod --reference="$ENV_FILE" "$env_tmp" 2>/dev/null || chmod 600 "$env_tmp"
grep -vE '^(PANEL_IMAGE_TAG|APP_VERSION)=' "$ENV_FILE" > "$env_tmp" || true
printf 'PANEL_IMAGE_TAG=%s\nAPP_VERSION=%s\n' "$PANEL_IMAGE_TAG" "$APP_VERSION" >> "$env_tmp"
mv -f "$env_tmp" "$ENV_FILE"

keep="${KEEP_RELEASES:-3}"
echo "==> Pruning release images beyond the newest ${keep}"
# The running and previous tags are always kept (rollback needs the previous
# one); of the rest, `docker image ls` lists newest first and the newest
# keep-2 survive.
previous="$(cat .release.prev 2>/dev/null || true)"
for image in "${IMAGES[@]}"; do
  docker image ls "squad-panel/${image}" --format '{{.Tag}}' |
    grep -vxF -e "$PANEL_IMAGE_TAG" -e "${previous:-$PANEL_IMAGE_TAG}" -e '<none>' |
    tail -n +"$((keep > 2 ? keep - 1 : 1))" |
    while IFS= read -r tag; do
      docker image rm "squad-panel/${image}:${tag}" >/dev/null 2>&1 || true
    done
done

echo "==> Container status"
compose ps
echo "==> Deploy complete. External: https://tk104.duckdns.org/"
