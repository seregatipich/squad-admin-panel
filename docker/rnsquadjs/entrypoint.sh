#!/usr/bin/env bash
set -euo pipefail

: "${SERVER_ID:?SERVER_ID is required}"
: "${LOG_FILE:=/squad/Logs/SquadGame.log}"

if [ ! -s /app/config.json ]; then
  echo "[panelBridge] /app/config.json missing or empty (must be bind-mounted by the bridge)" >&2
  exit 1
fi

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
