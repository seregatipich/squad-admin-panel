import type { BridgeClient } from '@squad/bridge-client';
import type { serverSettings } from '@squad/db/schema';
import {
  DEPOT_VOLUME_NAME,
  PANEL_CONFIGS_ROOT,
  PANEL_SAVED_ROOT,
  SERVER_IMAGE,
} from '@squad/shared-config';

/**
 * Replaces a server's squad container with a fresh `docker run` built from
 * its current `server_settings` (#30, finding #320). Ports, max players,
 * tickrate and MULTIHOME are baked into the container's arguments when it is
 * created, so restarting an existing container with `containerStart` would
 * silently ignore every PUT /settings change since — and leave it listening on
 * ports whose UFW rules that PUT already closed. Only stopped containers reach
 * this: callers short-circuit (start) or stop first (restart).
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @param settings - The server's current settings row.
 * @param exists - Whether a container is present to remove first.
 * @returns The new container's id.
 * @throws when the bridge refuses the remove or the run.
 */
export async function runFreshServerContainer(
  bridge: Pick<BridgeClient, 'containerRm' | 'containerRun'>,
  serverId: string,
  settings: typeof serverSettings.$inferSelect,
  exists: boolean,
): Promise<string> {
  if (exists) await bridge.containerRm({ name: `squad-${serverId}` });
  const run = await bridge.containerRun({
    server_id: serverId,
    image: SERVER_IMAGE,
    game_port: settings.gamePort,
    query_port: settings.queryPort,
    beacon_port: settings.beaconPort,
    rcon_port: settings.rconPort,
    max_players: settings.maxPlayers,
    tickrate: settings.tickrate,
    multihome: settings.multihome,
    configs_host: `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig`,
    saved_host: `${PANEL_SAVED_ROOT}/${serverId}`,
    depot_volume: DEPOT_VOLUME_NAME,
  });
  return run.container_id;
}
