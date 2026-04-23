#!/bin/sh
set -e
# The depot volume is mounted read-only, so only chown the RW bind-mounts
# that Docker may have auto-created as root when the host path didn't exist.
for d in /squad/SquadGame/Saved /squad/SquadGame/ServerConfig; do
  if [ -d "$d" ]; then
    chown -R 1001:1001 "$d" 2>/dev/null || true
  fi
done
exec runuser -u squad -- /squad/SquadGameServer.sh "$@"
