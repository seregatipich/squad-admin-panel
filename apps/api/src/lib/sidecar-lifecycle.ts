import type { BridgeClient } from '@squad/bridge-client';
import {
  resolveSidecarEngine,
  type SidecarEngine,
  sidecarConfigDir,
  sidecarContainerName,
} from '@squad/shared-config';
import { relaunchSidecar, type SidecarLaunchContext } from './rnsquadjs.js';
import { relaunchSquadjs2Sidecar, type Squadjs2LaunchContext } from './squadjs2.js';

/** Both sidecar engines, in the order lifecycle operations touch them. */
const ENGINES: readonly SidecarEngine[] = ['squadjs2', 'rnsquadjs'];

export type EngineAwareLaunchContext = SidecarLaunchContext & Squadjs2LaunchContext;

/**
 * Relaunches whichever sidecar engine the server is assigned to.
 *
 * Engine selection is desired state in Redis, so install/start/restart all read
 * it here rather than each deciding for itself.
 *
 * @param app - Database, bridge, Redis and logger.
 * @param serverId - Panel server UUID.
 * @returns The engine that was launched, its container id and its mode.
 */
export async function relaunchSidecarForEngine(
  app: EngineAwareLaunchContext,
  serverId: string,
): Promise<{ engine: SidecarEngine; containerId: string; mode: 'production' | 'shadow' }> {
  const engine = await resolveSidecarEngine(app.redis, serverId);
  const result =
    engine === 'squadjs2'
      ? await relaunchSquadjs2Sidecar(app, serverId)
      : await relaunchSidecar(app, serverId);
  return { engine, ...result };
}

/**
 * Stops both engines' sidecars for a server.
 *
 * Stop is symmetric across engines on purpose: a server that was switched while
 * running would otherwise leave the abandoned engine's container up.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @param onError - Called per engine whose stop failed; stopping is best-effort.
 */
export async function stopAllSidecars(
  bridge: Pick<BridgeClient, 'containerStop'>,
  serverId: string,
  onError?: (engine: SidecarEngine, err: unknown) => void,
): Promise<void> {
  await Promise.all(
    ENGINES.map((engine) =>
      bridge
        .containerStop({ name: sidecarContainerName(engine, serverId), timeout_sec: 30 })
        .catch((err: unknown) => onError?.(engine, err)),
    ),
  );
}

/**
 * Removes both engines' sidecar containers for a server.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 */
export async function removeAllSidecars(
  bridge: Pick<BridgeClient, 'containerRm'>,
  serverId: string,
): Promise<void> {
  await Promise.all(
    ENGINES.map((engine) =>
      bridge.containerRm({ name: sidecarContainerName(engine, serverId) }).catch(() => undefined),
    ),
  );
}

/**
 * Deletes both engines' per-server config directories.
 *
 * Each directory holds a rendered config carrying the server's plaintext RCON
 * password, so deleting a server must remove them; before this they outlived
 * the server forever.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @returns Whether every directory was removed (or was already absent).
 */
export async function purgeSidecarDirs(
  bridge: Pick<BridgeClient, 'directoryDelete'>,
  serverId: string,
): Promise<boolean> {
  const results = await Promise.all(
    ENGINES.map((engine) =>
      bridge
        .directoryDelete({ path: sidecarConfigDir(engine, serverId) })
        .then(() => true)
        .catch(() => false),
    ),
  );
  return results.every(Boolean);
}
