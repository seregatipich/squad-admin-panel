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
# Belt-and-braces: systemd UMask=0077 on the bridge unit can leave
# ServerConfig/ and its .cfg files at 0700/0600, which blocks Squad
# (uid 1001) from reading Rcon.cfg and prevents the RCON listener
# from starting. The bridge fsx.go now forces 0755/0644 explicitly,
# but we chmod here too so pre-fix installations recover on next
# container restart without needing a bridge redeploy.
if [ -d /squad/SquadGame/ServerConfig ]; then
  chmod 0755 /squad/SquadGame/ServerConfig 2>/dev/null || true
  find /squad/SquadGame/ServerConfig -type f -name '*.cfg' \
    -exec chmod 0644 {} + 2>/dev/null || true
fi
exec runuser -u squad -- /squad/SquadGameServer.sh "$@"
