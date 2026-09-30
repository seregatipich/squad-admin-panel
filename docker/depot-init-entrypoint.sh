#!/bin/sh
set -e
# Docker creates the bind/volume mount point as root by default. steamcmd
# runs as uid 1001 (steam) and silently ignores force_install_dir if the
# target isn't writable — the classic "Missing configuration" error.
if [ -d /depot ]; then
  # Recursing over every file on each run is a full-tree walk over what can be
  # tens of GB; only the files a previous run (or the bind mount itself)
  # didn't already leave as 1001:1001 need touching. Errors are no longer
  # swallowed so a real permission problem surfaces immediately instead of as
  # a later, unrelated steamcmd "Missing configuration" failure.
  find /depot ! -user 1001 -exec chown 1001:1001 {} +
fi
runuser -u steam -- /home/steam/steamcmd/steamcmd.sh "$@"
# Squad's depot ships SquadGame/ServerConfig/ but NOT SquadGame/Saved/;
# Squad creates Saved/ on first boot. Because the squad-server container
# mounts squad-depot:/squad:ro, Docker cannot mkdir a mount-point for
# the per-server Saved bind-mount inside the RO volume. Pre-create it
# here so the bind target always exists.
mkdir -p /depot/SquadGame/Saved
chown 1001:1001 /depot/SquadGame/Saved
