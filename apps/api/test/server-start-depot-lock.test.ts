import { serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

// #20: every Squad container mounts the one shared depot volume, so a server
// started or restarted while a depot update rewrites it boots on a half-written
// install. /start and /restart refuse while `depot:updating` is held.

const OWNER_STEAM_ID = testSteamId(931);

async function seedInstalledServer(h: IntegrationHarness, status: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Depot lock ${id.slice(0, 4)}`,
    slug: `depot-lock-${id}`,
    status,
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  return id;
}

let h: IntegrationHarness;
let bridgeStarts: string[];

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  bridgeStarts = [];
  const base = makeFakeBridge();
  Object.assign(h.bridge, base, {
    containerInspect: async (p: { name: string }) => ({
      ...(await base.containerInspect(p)),
      state: 'exited',
      running: false,
    }),
    containerStart: async ({ name }: { name: string }) => {
      bridgeStarts.push(`start:${name}`);
      return { status: 'ok' };
    },
    containerRun: async ({ server_id }: { server_id: string }) => {
      bridgeStarts.push(`run:${server_id}`);
      return { container_id: 'fake-container-id', status: 'started' };
    },
  });
  await h.redis.del('depot:updating');
});

describe.each(['start', 'restart'] as const)(
  'POST /api/v1/servers/:id/%s during a depot update',
  (action) => {
    it('returns 409 depot_update_in_progress and never touches the container', async () => {
      const id = await seedInstalledServer(h, 'stopped');
      await h.redis.set('depot:updating', new Date().toISOString(), 'EX', 3600);

      const cookie = await loginAsOwner(h);
      const resp = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${id}/${action}`,
        headers: { cookie },
      });

      expect(resp.statusCode).toBe(409);
      expect(resp.json().error).toBe('depot_update_in_progress');
      expect(bridgeStarts).toEqual([]);
      const row = await h.db.query.servers.findFirst({ where: eq(servers.id, id) });
      expect(row?.status).toBe('stopped');
    });

    it('proceeds once the depot lock is released', async () => {
      const id = await seedInstalledServer(h, 'stopped');

      const cookie = await loginAsOwner(h);
      const resp = await h.app.inject({
        method: 'POST',
        url: `/api/v1/servers/${id}/${action}`,
        headers: { cookie },
      });

      expect(resp.statusCode).toBe(200);
      expect(bridgeStarts.length).toBeGreaterThan(0);
    });
  },
);
