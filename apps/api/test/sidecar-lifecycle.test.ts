import type { BridgeClient } from '@squad/bridge-client';
import { SQUADJS2_ENGINE_SET } from '@squad/shared-config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The relaunch helpers write real files under /run; the dispatcher's job is
// picking the engine and passing the context through, so stub the writers.
vi.mock('../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rnsquadjs.js')>()),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rns-cid', mode: 'shadow' }),
}));
vi.mock('../src/lib/squadjs2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/squadjs2.js')>()),
  relaunchSquadjs2Sidecar: vi.fn().mockResolvedValue({ containerId: 'sjs2-cid', mode: 'shadow' }),
}));

import { relaunchSidecar } from '../src/lib/rnsquadjs.js';
import type { EngineAwareLaunchContext } from '../src/lib/sidecar-lifecycle.js';
import {
  purgeSidecarDirs,
  relaunchSidecarForEngine,
  removeAllSidecars,
  stopAllSidecars,
} from '../src/lib/sidecar-lifecycle.js';
import { relaunchSquadjs2Sidecar } from '../src/lib/squadjs2.js';

const SERVER_ID = '0190a000-0000-7000-8000-000000000001';

function makeApp(engineMember: number): EngineAwareLaunchContext {
  return {
    redis: { sismember: vi.fn(async () => engineMember) },
  } as unknown as EngineAwareLaunchContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('relaunchSidecarForEngine', () => {
  it('launches SquadJS2 for a member of the engine set', async () => {
    const app = makeApp(1);

    const result = await relaunchSidecarForEngine(app, SERVER_ID);

    expect(result).toEqual({ engine: 'squadjs2', containerId: 'sjs2-cid', mode: 'shadow' });
    expect(relaunchSquadjs2Sidecar).toHaveBeenCalledWith(app, SERVER_ID);
    expect(relaunchSidecar).not.toHaveBeenCalled();
  });

  it('launches RNSquadJS for a server outside the engine set', async () => {
    const app = makeApp(0);

    const result = await relaunchSidecarForEngine(app, SERVER_ID);

    expect(result).toEqual({ engine: 'rnsquadjs', containerId: 'rns-cid', mode: 'shadow' });
    expect(relaunchSidecar).toHaveBeenCalledWith(app, SERVER_ID);
    expect(relaunchSquadjs2Sidecar).not.toHaveBeenCalled();
  });

  it('reads exactly the engine set', async () => {
    const app = makeApp(0);
    await relaunchSidecarForEngine(app, SERVER_ID);
    expect(app.redis.sismember).toHaveBeenCalledWith(SQUADJS2_ENGINE_SET, SERVER_ID);
  });
});

describe('stopAllSidecars', () => {
  it('stops both engines', async () => {
    const containerStop = vi.fn().mockResolvedValue({ status: 'ok' });

    await stopAllSidecars({ containerStop } as unknown as BridgeClient, SERVER_ID);

    expect(containerStop.mock.calls.map((c) => c[0].name).sort()).toEqual([
      `rnsquadjs-${SERVER_ID}`,
      `squadjs2-${SERVER_ID}`,
    ]);
  });

  it('reports per-engine failures without throwing', async () => {
    const containerStop = vi.fn(async ({ name }: { name: string }) => {
      if (name.startsWith('squadjs2')) throw new Error('no such container');
      return { status: 'ok' };
    });
    const failures: string[] = [];

    await stopAllSidecars({ containerStop } as unknown as BridgeClient, SERVER_ID, (engine) =>
      failures.push(engine),
    );

    expect(failures).toEqual(['squadjs2']);
  });
});

describe('removeAllSidecars', () => {
  it('removes both engines and swallows a missing container', async () => {
    const containerRm = vi.fn(async ({ name }: { name: string }) => {
      if (name.startsWith('rnsquadjs')) throw new Error('No such container');
      return { status: 'ok' };
    });

    await expect(
      removeAllSidecars({ containerRm } as unknown as BridgeClient, SERVER_ID),
    ).resolves.toBeUndefined();
    expect(containerRm).toHaveBeenCalledTimes(2);
  });
});

describe('purgeSidecarDirs', () => {
  it('deletes both engines config dirs', async () => {
    const directoryDelete = vi.fn().mockResolvedValue({ removed: true });

    const ok = await purgeSidecarDirs({ directoryDelete } as unknown as BridgeClient, SERVER_ID);

    expect(ok).toBe(true);
    expect(directoryDelete.mock.calls.map((c) => c[0].path).sort()).toEqual([
      `/run/squad-panel/rnsquadjs/${SERVER_ID}`,
      `/run/squad-panel/squadjs2/${SERVER_ID}`,
    ]);
  });

  it('reports false when a directory could not be removed', async () => {
    const directoryDelete = vi.fn().mockRejectedValue(new Error('forbidden'));

    await expect(
      purgeSidecarDirs({ directoryDelete } as unknown as BridgeClient, SERVER_ID),
    ).resolves.toBe(false);
  });
});
