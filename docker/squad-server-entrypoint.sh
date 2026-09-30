#!/bin/sh
set -e
# Saved/ is RW (Squad writes logs, workshop cache, persistent data).
# ServerConfig/ is panel-owned: the bridge writes the .cfg files as root,
# Squad only READS them at boot + during hot-reload polls, so there is no
# reason to re-own ServerConfig/ to uid 1001 — it stays with the bridge.
if [ -d /squad/SquadGame/Saved ]; then
  chown -R 1001:1001 /squad/SquadGame/Saved 2>/dev/null || true
fi
# Belt-and-braces: systemd UMask=0077 on the bridge unit can leave
# ServerConfig/ and its .cfg files at 0700/0600, which blocks Squad
# (uid 1001) from reading Rcon.cfg and prevents the RCON listener
# from starting. The bridge fsx.go now forces 0755/0644 explicitly,
# but we fix permissions here too so pre-fix installations recover on
# next container restart without needing a bridge redeploy.
#
# Group-readable rather than world-readable: Rcon.cfg holds the RCON
# password and Admins.cfg the admin roster, and ServerConfig is a bind
# mount visible to the host and to any other container that mounts it.
# Re-owning the group to squad's own gid (1001) — instead of relying on
# whatever group the bridge (root) wrote the files with — means only
# Squad itself, not "other" (any local user/container), can read them.
if [ -d /squad/SquadGame/ServerConfig ]; then
  chgrp -R 1001 /squad/SquadGame/ServerConfig 2>/dev/null || true
  chmod 0750 /squad/SquadGame/ServerConfig 2>/dev/null || true
  find /squad/SquadGame/ServerConfig -type f -name '*.cfg' \
    -exec chmod 0640 {} + 2>/dev/null || true
fi
exec runuser -u squad -- /squad/SquadGameServer.sh "$@"
