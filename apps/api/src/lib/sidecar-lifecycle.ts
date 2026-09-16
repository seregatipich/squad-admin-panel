import type { BridgeClient } from '@squad/bridge-client';
import { sidecarConfigDir, sidecarContainerName } from './rnsquadjs.js';

/**
 * Stops a server's RNSquadJS sidecar.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @param onError - Called when the stop failed; stopping is best-effort and
 *   never throws, because the sidecar is not load-bearing for the server.
 */
export async function stopSidecar(
  bridge: Pick<BridgeClient, 'containerStop'>,
  serverId: string,
  onError?: (err: unknown) => void,
): Promise<void> {
  await bridge
    .containerStop({ name: sidecarContainerName(serverId), timeout_sec: 30 })
    .catch((err: unknown) => onError?.(err));
}

/**
 * Removes a server's RNSquadJS sidecar container.
 *
 * A missing container is not an error: the sidecar may never have launched.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 */
export async function removeSidecar(
  bridge: Pick<BridgeClient, 'containerRm'>,
  serverId: string,
): Promise<void> {
  await bridge.containerRm({ name: sidecarContainerName(serverId) }).catch(() => undefined);
}

/**
 * Deletes a server's sidecar config directory.
 *
 * The directory holds a rendered config carrying the server's plaintext RCON
 * password, so deleting a server must remove it.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @returns Whether the directory was removed (or was already absent).
 */
export async function purgeSidecarDir(
  bridge: Pick<BridgeClient, 'directoryDelete'>,
  serverId: string,
): Promise<boolean> {
  return bridge
    .directoryDelete({ path: sidecarConfigDir(serverId) })
    .then(() => true)
    .catch(() => false);
}
