import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198222000001n;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
});

afterEach(async () => {
  await h.cleanup();
});

/** Inserts a server + settings row and returns the server id. */
async function seedServer(opts: {
  slug: string;
  status?: string;
  gamePort?: number;
  queryPort?: number;
  beaconPort?: number;
  rconPort?: number;
}): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: `Test ${opts.slug}`,
    slug: opts.slug,
    status: (opts.status ?? 'stopped') as 'stopped',
  });
  await h.db.insert(serverSettings).values({
    serverId: id,
    installPath: `/var/lib/squad-panel/configs/${id}`,
    gamePort: opts.gamePort ?? 7787,
    queryPort: opts.queryPort ?? 27165,
    beaconPort: opts.beaconPort ?? 15000,
    rconPort: opts.rconPort ?? 21114,
    maxPlayers: 80,
    tickrate: 50,
  });
  await h.db.insert(serverCredentials).values({
    serverId: id,
    rconPort: opts.rconPort ?? 21114,
    rconPasswordEncrypted: Buffer.alloc(64, 0x01),
  });
  return id;
}

// ---------------------------------------------------------------------------
// PUT /api/v1/servers/:id/settings
// ---------------------------------------------------------------------------

describe('PUT /api/v1/servers/:id/settings', () => {
  it('updates max_players and tickrate on a stopped server → 200', async () => {
    const serverId = await seedServer({ slug: 'settings-update-ok', status: 'stopped' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { max_players: 60, tickrate: 40 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { max_players: number; tickrate: number };
    expect(body.max_players).toBe(60);
    expect(body.tickrate).toBe(40);

    // verify DB was actually updated
    const row = await h.db.query.serverSettings.findFirst({
      where: eq(serverSettings.serverId, serverId),
    });
    expect(row?.maxPlayers).toBe(60);
    expect(row?.tickrate).toBe(40);

    await assertAuditRow(h, {
      action: 'server.update_settings',
      resource: 'server',
      targetId: serverId,
    });
  });

  it('rejects port change on a running server → 409', async () => {
    const serverId = await seedServer({ slug: 'settings-running-port', status: 'running' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { game_port: 7999 },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('server_running');
  });

  it('rejects duplicate ports across servers → 409', async () => {
    // server A owns port 7790
    await seedServer({
      slug: 'settings-conflict-a',
      status: 'stopped',
      gamePort: 7790,
      queryPort: 27170,
      beaconPort: 15010,
      rconPort: 21120,
    });
    // server B wants to claim port 7790
    const serverBId = await seedServer({
      slug: 'settings-conflict-b',
      status: 'stopped',
      gamePort: 7800,
      queryPort: 27180,
      beaconPort: 15020,
      rconPort: 21130,
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverBId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { game_port: 7790 },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('port_conflict');
  });

  it('allows resource-limit changes on a running server → 200', async () => {
    const serverId = await seedServer({ slug: 'settings-resource-running', status: 'running' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        cpu_weight: 500,
        niceness: -5,
        memory_high_mb: 4096,
        memory_max_mb: 8192,
        io_weight: 100,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cpu_weight: number;
      niceness: number;
      memory_high_mb: number;
      memory_max_mb: number;
      io_weight: number;
    };
    expect(body.cpu_weight).toBe(500);
    expect(body.niceness).toBe(-5);
    expect(body.memory_high_mb).toBe(4096);
    expect(body.memory_max_mb).toBe(8192);
    expect(body.io_weight).toBe(100);
  });

  it('calls ufwRule remove+add when a port changes on a stopped server', async () => {
    const serverId = await seedServer({
      slug: 'settings-ufw',
      status: 'stopped',
      gamePort: 7787,
      queryPort: 27165,
      beaconPort: 15000,
      rconPort: 21114,
    });
    const ufwCalls: Array<{ action: string; port: number; proto: string }> = [];
    h.bridge.ufwRule = vi.fn(async (p) => {
      ufwCalls.push({ action: p.action, port: p.port, proto: p.proto });
      return { output: '', status: 'ok' };
    });

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { game_port: 7799 },
    });

    expect(res.statusCode).toBe(200);
    expect(ufwCalls).toContainEqual({ action: 'remove', port: 7787, proto: 'udp' });
    expect(ufwCalls).toContainEqual({ action: 'add', port: 7799, proto: 'udp' });
  });

  it('returns 404 for an unknown server id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${uuidv7()}/settings`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { max_players: 50 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without authentication', async () => {
    const serverId = await seedServer({ slug: 'settings-unauth', status: 'stopped' });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/settings`,
      headers: { 'content-type': 'application/json' },
      payload: { max_players: 50 },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/servers/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/servers/:id', () => {
  it('updates display_name and tags → 200', async () => {
    const serverId = await seedServer({ slug: 'patch-meta', status: 'stopped' });
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { display_name: 'New Name', tags: ['pvp', 'ru'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { display_name: string; tags: string[]; id: string };
    expect(body.display_name).toBe('New Name');
    expect(body.tags).toEqual(['pvp', 'ru']);
    expect(body.id).toBe(serverId);

    // verify DB
    const row = await h.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
    expect(row?.displayName).toBe('New Name');
    expect(row?.tags).toEqual(['pvp', 'ru']);

    await assertAuditRow(h, { action: 'server.patch', resource: 'server', targetId: serverId });
  });

  it('updates description (nullable)', async () => {
    const serverId = await seedServer({ slug: 'patch-desc', status: 'stopped' });
    const cookie = await loginAsOwner(h);

    // set description
    const res1 = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { description: 'A cool server' },
    });
    expect(res1.statusCode).toBe(200);
    expect((res1.json() as { description: string }).description).toBe('A cool server');

    // clear description
    const res2 = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { description: null },
    });
    expect(res2.statusCode).toBe(200);
    expect((res2.json() as { description: string | null }).description).toBeNull();
  });

  it('returns 404 for an unknown server id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${uuidv7()}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { display_name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without authentication', async () => {
    const serverId = await seedServer({ slug: 'patch-unauth', status: 'stopped' });
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}`,
      headers: { 'content-type': 'application/json' },
      payload: { display_name: 'X' },
    });
    expect(res.statusCode).toBe(401);
  });
});
