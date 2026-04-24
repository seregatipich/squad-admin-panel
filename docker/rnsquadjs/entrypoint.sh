#!/usr/bin/env bash
set -euo pipefail

: "${SERVER_ID:?SERVER_ID is required}"
: "${API_URL:?API_URL is required}"
: "${LOG_FILE:=/squad/Logs/SquadGame.log}"

echo "[panelBridge] fetching config for ${SERVER_ID} from ${API_URL}"
curl --silent --fail --retry 10 --retry-delay 3 --max-time 5 \
  "${API_URL}/internal/rnsquadjs/config/${SERVER_ID}" -o /app/config.json

echo "[panelBridge] waiting for ${LOG_FILE} (up to 60s)"
deadline=$(( $(date +%s) + 60 ))
until [ -f "${LOG_FILE}" ]; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "[panelBridge] timed out waiting for ${LOG_FILE}" >&2
    exit 1
  fi
  sleep 1
done
echo "[panelBridge] log file present; upstream SHA: $(cat /UPSTREAM_SHA 2>/dev/null || echo unknown)"

exec node lib/index.js
