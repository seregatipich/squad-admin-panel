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
    const onError = vi.fn();

    await expect(
      removeSidecar({ containerRm } as unknown as BridgeClient, SERVER_ID, onError),
    ).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports any other removal failure without throwing (#58)', async () => {
    const failure = new Error('bridge transport closed');
    const containerRm = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    await expect(
      removeSidecar({ containerRm } as unknown as BridgeClient, SERVER_ID, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
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

  it('reports false and the error when the directory could not be removed (#58)', async () => {
    const failure = new Error('forbidden');
    const directoryDelete = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();

    await expect(
      purgeSidecarDir({ directoryDelete } as unknown as BridgeClient, SERVER_ID, onError),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
