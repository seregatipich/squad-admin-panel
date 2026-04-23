#!/bin/sh
set -e
# Saved/ is RW (Squad writes logs, workshop cache, persistent data).
# ServerConfig/ is panel-owned: the bridge writes the .cfg files as root,
# Squad only READS them at boot + during hot-reload polls. Re-owning
# ServerConfig/ to uid 1001 would block the bridge (CAP_DAC_READ_SEARCH
# is not in the bounding set), so we deliberately leave it alone.
if [ -d /squad/SquadGame/Saved ]; then
  chown -R 1001:1001 /squad/SquadGame/Saved 2>/dev/null || true
fi
exec runuser -u squad -- /squad/SquadGameServer.sh "$@"
