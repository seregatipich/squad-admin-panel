#!/bin/sh
# Entrypoint for the panel's SquadJS2 sidecar.
#
# The sidecar starts alongside the Squad container, so the log file it tails may
# not exist yet: SquadJS2's tail reader throws on a missing file at construction
# time, which would crash-loop the container. Wait for it, then hand over.
set -eu

CONFIG_PATH=/app/panel-config.json
LOG_FILE="${LOG_FILE:-/squad/Logs/SquadGame.log}"
WAIT_SECONDS="${LOG_WAIT_SECONDS:-60}"

if [ -z "${SERVER_ID:-}" ]; then
  echo "panel-sidecar: SERVER_ID is required" >&2
  exit 64
fi

if [ ! -s "$CONFIG_PATH" ]; then
  echo "panel-sidecar: $CONFIG_PATH is missing or empty" >&2
  exit 65
fi

waited=0
while [ ! -f "$LOG_FILE" ]; do
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "panel-sidecar: $LOG_FILE did not appear within ${WAIT_SECONDS}s" >&2
    exit 69
  fi
  sleep 1
  waited=$((waited + 1))
done

echo "panel-sidecar: starting SquadJS2 for server ${SERVER_ID} on ${LOG_FILE}"
exec dumb-init node index.js "$CONFIG_PATH"
