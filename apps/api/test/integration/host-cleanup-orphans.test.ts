import { servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const ORPHAN_UUID = 'bbbbbbbb-2222-4222-8222-222222222222';

let h: IntegrationHarness;
let knownServerId: string;

const listPanelDirs = vi.fn();
const listSquadContainers = vi.fn();
const containerStop = vi.fn(async () => ({ status: 'ok' }));
const containerRm = vi.fn(async () => ({ status: 'ok' }));
const directoryDelete = vi.fn(async () => ({ removed: true }));

describeIfDb('POST /api/v1/host/cleanup-orphans (#66)', () => {
  beforeAll(async () => {
    const bridge = Object.assign(
      makeFakeBridge({ containerStop, containerRm, directoryDelete } as never),
      { listPanelDirs, listSquadContainers },
    );
    h = await buildIntegrationApp({ bridge, seedOwner: { steamId64: testSteamId(930) } });
    knownServerId = uuidv7();
    await h.db.insert(servers).values({
      id: knownServerId,
      displayName: 'Orphan sweep known',
      slug: `orphan-known-${knownServerId.slice(0, 8)}`,
      status: 'stopped',
    });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('removes an orphan RNSquadJS sidecar and its config dir but keeps a known server', async () => {
    listPanelDirs.mockResolvedValue({
      configs: [knownServerId],
      saved: [knownServerId],
      sidecars: [knownServerId, ORPHAN_UUID],
    });
    listSquadContainers.mockResolvedValue({
      containers: [`squad-${knownServerId}`],
      sidecars: [`rnsquadjs-${knownServerId}`, `rnsquadjs-${ORPHAN_UUID}`],
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/cleanup-orphans',
      headers: { cookie: await loginAsOwner(h) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orphans_configs).toEqual([]);
    expect(body.orphans_containers).toEqual([]);
    expect(body.removed_sidecar_containers).toEqual([ORPHAN_UUID]);
    expect(body.removed_sidecar_dirs).toEqual([ORPHAN_UUID]);
    expect(containerRm).toHaveBeenCalledWith({ name: `rnsquadjs-${ORPHAN_UUID}` });
    expect(containerRm).not.toHaveBeenCalledWith({ name: `rnsquadjs-${knownServerId}` });
    expect(directoryDelete).toHaveBeenCalledWith({
      path: `/run/squad-panel/rnsquadjs/${ORPHAN_UUID}`,
    });
    expect(directoryDelete).toHaveBeenCalledTimes(1);
  });
});
