#!/bin/sh
set -e
# Docker creates the bind/volume mount point as root by default. steamcmd
# runs as uid 1001 (steam) and silently ignores force_install_dir if the
# target isn't writable — the classic "Missing configuration" error.
if [ -d /depot ]; then
  chown -R 1001:1001 /depot 2>/dev/null || true
fi
runuser -u steam -- /home/steam/steamcmd/steamcmd.sh "$@"
# Squad's depot ships SquadGame/ServerConfig/ but NOT SquadGame/Saved/;
# Squad creates Saved/ on first boot. Because the squad-server container
# mounts squad-depot:/squad:ro, Docker cannot mkdir a mount-point for
# the per-server Saved bind-mount inside the RO volume. Pre-create it
# here so the bind target always exists.
mkdir -p /depot/SquadGame/Saved
chown 1001:1001 /depot/SquadGame/Saved
