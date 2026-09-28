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

const MISSING_CONTAINER_RE = /not_found|no such container/i;

/**
 * Removes a server's RNSquadJS sidecar container.
 *
 * A missing container is not an error: the sidecar may never have launched.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @param onError - Called with any other failure; removal is best-effort and
 *   never throws, so the caller decides how to surface it.
 */
export async function removeSidecar(
  bridge: Pick<BridgeClient, 'containerRm'>,
  serverId: string,
  onError?: (err: unknown) => void,
): Promise<void> {
  await bridge.containerRm({ name: sidecarContainerName(serverId) }).catch((err: unknown) => {
    if (MISSING_CONTAINER_RE.test((err as Error)?.message ?? '')) return;
    onError?.(err);
  });
}

/**
 * Deletes a server's sidecar config directory.
 *
 * The directory holds a rendered config carrying the server's plaintext RCON
 * password, so deleting a server must remove it — and a failure must reach the
 * caller with its reason instead of vanishing into a bare `false`.
 *
 * @param bridge - Bridge client.
 * @param serverId - Panel server UUID.
 * @param onError - Called with the bridge error when the delete failed.
 * @returns Whether the directory was removed (or was already absent).
 */
export async function purgeSidecarDir(
  bridge: Pick<BridgeClient, 'directoryDelete'>,
  serverId: string,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  return bridge
    .directoryDelete({ path: sidecarConfigDir(serverId) })
    .then(() => true)
    .catch((err: unknown) => {
      onError?.(err);
      return false;
    });
}
