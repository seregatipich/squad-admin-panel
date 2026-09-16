import type { BridgeClient } from '@squad/bridge-client';
import { describe, expect, it, vi } from 'vitest';
import { purgeSidecarDir, removeSidecar, stopSidecar } from '../src/lib/sidecar-lifecycle.js';

const SERVER_ID = '0190a000-0000-7000-8000-000000000001';

describe('stopSidecar', () => {
  it('stops the RNSquadJS sidecar of the server', async () => {
    const containerStop = vi.fn().mockResolvedValue({ status: 'ok' });

    await stopSidecar({ containerStop } as unknown as BridgeClient, SERVER_ID);

    expect(containerStop).toHaveBeenCalledWith({ name: `rnsquadjs-${SERVER_ID}`, timeout_sec: 30 });
  });

  it('reports a failed stop without throwing', async () => {
    const failure = new Error('no such container');
    const containerStop = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    await expect(
      stopSidecar({ containerStop } as unknown as BridgeClient, SERVER_ID, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe('removeSidecar', () => {
  it('removes the RNSquadJS sidecar container', async () => {
    const containerRm = vi.fn().mockResolvedValue({ status: 'ok' });

    await removeSidecar({ containerRm } as unknown as BridgeClient, SERVER_ID);

    expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${SERVER_ID}` });
  });

  it('swallows a missing container', async () => {
    const containerRm = vi.fn().mockRejectedValue(new Error('No such container'));

    await expect(
      removeSidecar({ containerRm } as unknown as BridgeClient, SERVER_ID),
    ).resolves.toBeUndefined();
  });
});

describe('purgeSidecarDir', () => {
  it('deletes the sidecar config dir', async () => {
    const directoryDelete = vi.fn().mockResolvedValue({ removed: true });

    const ok = await purgeSidecarDir({ directoryDelete } as unknown as BridgeClient, SERVER_ID);

    expect(ok).toBe(true);
    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/rnsquadjs/${SERVER_ID}`,
    });
  });

  it('reports false when the directory could not be removed', async () => {
    const directoryDelete = vi.fn().mockRejectedValue(new Error('forbidden'));

    await expect(
      purgeSidecarDir({ directoryDelete } as unknown as BridgeClient, SERVER_ID),
    ).resolves.toBe(false);
  });
});
