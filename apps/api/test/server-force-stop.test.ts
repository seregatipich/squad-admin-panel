import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = testSteamId(930);

interface SeededServer {
  id: string;
  slug: string;
}

async function seedServer(
  h: IntegrationHarness,
  opts: { slug: string; status?: string },
): Promise<SeededServer> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Test ${opts.slug}`,
    slug: opts.slug,
    status: (opts.status ?? 'running') as 'running',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: 7787,
    queryPort: 27165,
    beaconPort: 15000,
    rconPort: 21114,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return { id, slug: opts.slug };
}

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterAll(async () => {
  await h.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/v1/servers/:id/force-stop', () => {
  it('force-stops a running server via containerRm with force:true → 200, DB status = stopped', async () => {
    const seeded = await seedServer(h, { slug: 'force-stop-running', status: 'running' });
    const containerRm = vi.spyOn(h.bridge, 'containerRm');

    const events: unknown[] = [];
    const off = h.app.liveBus.subscribe((evt) => events.push(evt));

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${seeded.id}/force-stop`,
      headers: { cookie },
    });

    off();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; server_id: string };
    expect(body.status).toBe('stopped');
    expect(body.server_id).toBe(seeded.id);

    expect(containerRm).toHaveBeenCalledWith({ name: `squad-${seeded.id}`, force: true });

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.status).toBe('stopped');

    expect(
      events.some(
        (e) =>
          (e as { type: string; data: { source: string } }).type === 'server.status' &&
          (e as { type: string; data: { source: string } }).data.source === 'force_stop',
      ),
    ).toBe(true);
  });

  it('returns 404 for a non-existent server', async () => {
    const cookie = await loginAsOwner(h);
    const nonExistentId = uuidv7();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${nonExistentId}/force-stop`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 409 when server is already stopped (not in stoppable state)', async () => {
    const seeded = await seedServer(h, { slug: 'force-stop-stopped', status: 'stopped' });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${seeded.id}/force-stop`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('server_not_stoppable');
  });

  it('force-stops a server in starting state', async () => {
    const seeded = await seedServer(h, { slug: 'force-stop-starting', status: 'starting' });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${seeded.id}/force-stop`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('stopped');

    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, seeded.id) });
    expect(row?.status).toBe('stopped');
  });

  it('force-stops a server in stopping state', async () => {
    const seeded = await seedServer(h, { slug: 'force-stop-stopping', status: 'stopping' });
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${seeded.id}/force-stop`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('stopped');
  });
});
