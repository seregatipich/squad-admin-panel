import { players, roles, serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { relaunchSidecar } from '../../src/lib/rnsquadjs.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// The start/restart routes relaunch the per-server rnsquadjs sidecar via
// relaunchSidecar, which performs real fs writes under /run and consults
// redis/bridge. Stub the whole helper so these route tests assert the call
// contract (invoked on success, non-fatal on failure) without touching the
// host runtime dir. The helper's own behaviour is covered in lib/rnsquadjs.test.
vi.mock('../../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rnsquadjs.js')>()),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rnsquadjs-test', mode: 'shadow' }),
}));

const OWNER_STEAM_ID = 76561198000000999n;

const createBody = {
  display_name: 'Test Server',
  slug: 'test-server',
  description: 'integration fixture',
  game_port: 7787,
  query_port: 27165,
  beacon_port: 15000,
  rcon_port: 21114,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;

beforeEach(async () => {
  vi.mocked(relaunchSidecar).mockClear();
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function login(): Promise<string> {
  return loginAsOwner(h);
}

describe('GET /api/v1/servers', () => {
  it('returns empty list for a fresh org', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ items: [], total: 0 });
  });

  it('merges rcon:status Redis key into the response', async () => {
    const cookie = await login();
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: createBody,
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json<{ id: string }>();
    await h.redis.set(
      `rcon:status:${id}`,
      JSON.stringify({
        state: 'connected',
        player_count: 42,
        last_poll_at: '2026-04-23T00:00:00Z',
      }),
    );

    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      items: Array<{ id: string; rcon_state: string; player_count: number }>;
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.rcon_state).toBe('connected');
    expect(body.items[0]?.player_count).toBe(42);
  });
});

describe('POST /api/v1/servers', () => {
  it('inserts server + settings + credentials rows and writes audit row', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: createBody,
    });
    expect(resp.statusCode).toBe(201);
    const { id } = resp.json<{ id: string }>();

    const [s] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(s?.status).toBe('pending');
    expect(s?.displayName).toBe('Test Server');

    const [settings] = await h.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, id));
    expect(settings?.gamePort).toBe(7787);
    expect(settings?.maxPlayers).toBe(80);

    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(creds?.rconPort).toBe(21114);
    expect(creds?.rconPasswordEncrypted).toBeTruthy();
    // rcon_host must be NULL so per-service RCON_HOST_DEFAULT (api vs
    // worker-rcon) decides the actual dial target at connect time. See
    // docs/bridge-protocol + resolveRconHost in shared-config.
    expect(creds?.rconHost).toBeNull();

    // The POST /servers route has no :id in the URL, so `extractTargetId` in
    // audit plugin returns null; we assert action+resource only here.
    void id;
    await assertAuditRow(h, { action: 'server.create', resource: 'server' });
  });

  it('rejects a body missing required fields with 400/422', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: { display_name: 'Bad' },
    });
    expect([400, 422]).toContain(resp.statusCode);
  });

  it('rejects a body with duplicate ports within the same server with 400/422', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: { ...createBody, slug: 'dup-ports-test', query_port: createBody.game_port },
    });
    expect([400, 422]).toContain(resp.statusCode);
  });

  it('rejects creating a server whose port collides with an existing server with 409 port_conflict', async () => {
    const cookie = await login();
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: { ...createBody, slug: 'port-collision-a' },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        ...createBody,
        slug: 'port-collision-b',
        game_port: createBody.game_port,
        query_port: 27166,
        beacon_port: 15001,
        rcon_port: 21115,
      },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: 'port_conflict',
      message: 'One or more ports are already in use by another server.',
    });
  });

  it('creates a second server with distinct, non-colliding ports (control)', async () => {
    const cookie = await login();
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: { ...createBody, slug: 'no-collision-a' },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        ...createBody,
        slug: 'no-collision-b',
        game_port: 7788,
        query_port: 27166,
        beacon_port: 15001,
        rcon_port: 21115,
      },
    });
    expect(second.statusCode).toBe(201);
  });
});

describe('GET /api/v1/servers/:id', () => {
  it('returns 404 for unknown id', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019e0000-0000-7000-8000-000000000000',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });

  it('returns the full server shape when the row exists', async () => {
    const cookie = await login();
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: createBody,
    });
    const { id } = create.json<{ id: string }>();
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      server: { id: string; display_name: string; status: string };
      settings: { game_port: number } | null;
      rcon_status: { state: string };
    }>();
    expect(body.server.id).toBe(id);
    expect(body.server.display_name).toBe('Test Server');
    expect(body.settings?.game_port).toBe(7787);
    expect(body.rcon_status.state).toBe('not_polled');
  });
});

describe('POST /api/v1/servers/:id/start', () => {
  it('calls container_run via the bridge and flips status to starting', async () => {
    let ran = false;
    h.bridge.containerRun = async () => {
      ran = true;
      return { container_id: 'abc' };
    };
    h.bridge.containerInspect = async () => ({ state: 'not_found' });
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'starting' });
    expect(ran).toBe(true);

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('starting');
    await assertAuditRow(h, { action: 'server.start', resource: 'server', targetId: id });
  });

  it('short-circuits when the container is already running', async () => {
    h.bridge.containerInspect = async () => ({ running: true, state: 'running' });
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'running', note: 'already running' });
  });

  it('relaunches the rnsquadjs sidecar after the squad container starts', async () => {
    h.bridge.containerInspect = async () => ({ state: 'not_found' });
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'start-relaunch-sidecar' },
      })
    ).json<{ id: string }>();

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(relaunchSidecar).toHaveBeenCalledWith(expect.anything(), id);
  });

  it('still returns 200 when the sidecar relaunch rejects', async () => {
    h.bridge.containerInspect = async () => ({ state: 'not_found' });
    vi.mocked(relaunchSidecar).mockRejectedValueOnce(new Error('rnsquadjs image missing'));
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'start-relaunch-reject' },
      })
    ).json<{ id: string }>();

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'starting' });
  });
});

describe('POST /api/v1/servers/:id/stop', () => {
  it('calls container_stop and transitions to stopping when no creds are present', async () => {
    let stopped = false;
    h.bridge.containerStop = async () => {
      stopped = true;
    };
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    // Remove credentials so the stop route skips the 15 s graceful RCON path.
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/stop`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'stopping' });
    expect(stopped).toBe(true);
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('stopping');
    await assertAuditRow(h, { action: 'server.stop', resource: 'server', targetId: id });
  });

  it('writes status=starting BEFORE calling container_run/start so a crash leaves a recoverable state', async () => {
    const cookie = await login();
    h.bridge.containerInspect = async () => ({ state: 'not_found' });
    let statusAtRunCall: string | null = null;
    h.bridge.containerRun = async () => {
      const [row] = await h.db.select().from(servers);
      statusAtRunCall = row?.status ?? null;
      return { container_id: 'abc', status: 'started' };
    };
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'eager-start-test' },
      })
    ).json<{ id: string }>();
    void id;
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/start`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(statusAtRunCall).toBe('starting');
  });

  it('writes status=stopping BEFORE calling container_stop so a crash mid-stop leaves a recoverable state', async () => {
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));
    await h.db
      .update(servers)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(servers.id, id));

    let statusAtStopCall: string | null = null;
    h.bridge.containerStop = async () => {
      const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
      statusAtStopCall = row?.status ?? null;
    };

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/stop`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(statusAtStopCall).toBe('stopping');
  });

  it('stops the rnsquadjs sidecar alongside the squad container', async () => {
    const containerStop = vi.fn(async () => ({ status: 'ok' }));
    h.bridge.containerStop = containerStop;
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'stop-sidecar-test' },
      })
    ).json<{ id: string }>();
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/stop`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(containerStop).toHaveBeenCalledWith({ name: `squad-${id}`, timeout_sec: 60 });
    expect(containerStop).toHaveBeenCalledWith({ name: `rnsquadjs-${id}`, timeout_sec: 30 });
  });

  it('still returns 200 when the sidecar stop rejects', async () => {
    const containerStop = vi.fn(async ({ name }: { name: string }) => {
      if (name.startsWith('rnsquadjs-')) throw new Error('sidecar gone');
      return { status: 'ok' };
    });
    h.bridge.containerStop = containerStop;
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'stop-sidecar-reject' },
      })
    ).json<{ id: string }>();
    await h.db.delete(serverCredentials).where(eq(serverCredentials.serverId, id));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/stop`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'stopping' });
  });
});

describe('POST /api/v1/servers/:id/restart', () => {
  it('issues stop+start via bridge and flips status to starting', async () => {
    let startCalls = 0;
    h.bridge.containerStart = async () => {
      startCalls++;
    };
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/restart`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
    expect(startCalls).toBe(1);
    await assertAuditRow(h, { action: 'server.restart', resource: 'server', targetId: id });
  });

  it('relaunches the rnsquadjs sidecar after the squad container restarts', async () => {
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'restart-relaunch-sidecar' },
      })
    ).json<{ id: string }>();

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/restart`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(relaunchSidecar).toHaveBeenCalledWith(expect.anything(), id);
  });

  it('still returns 200 when the sidecar relaunch rejects on restart', async () => {
    vi.mocked(relaunchSidecar).mockRejectedValueOnce(new Error('rnsquadjs image missing'));
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: { ...createBody, slug: 'restart-relaunch-reject' },
      })
    ).json<{ id: string }>();

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${id}/restart`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
  });
});

describe('DELETE /api/v1/servers/:id', () => {
  it('preserves config_versions history (soft-delete) and appends backup-marker rows', async () => {
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'v1', message: 'a' },
    });
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/configs/Admins.cfg`,
      headers: { cookie },
      payload: { content: 'v2', message: 'b' },
    });
    const { configVersions } = await import('@squad/db/schema');
    const before = await h.db.select().from(configVersions).where(eq(configVersions.serverId, id));
    expect(before.length).toBeGreaterThanOrEqual(2);

    const resp = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);

    const [srv] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(srv?.deletedAt).not.toBeNull();
    const after = await h.db.select().from(configVersions).where(eq(configVersions.serverId, id));
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('soft-deletes the row, calls container_rm, and writes audit', async () => {
    let removed = false;
    h.bridge.containerRm = async () => {
      removed = true;
      return { status: 'ok' };
    };
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    // Seed at least one config file so the backup phase has something to read.
    h.bridge.files.set(
      `/var/lib/squad-panel/configs/${id}/ServerConfig/Admins.cfg`,
      Buffer.from('Admin=76561198000000999:Owner\n', 'utf-8'),
    );
    const resp = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { ok: boolean; container_removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.container_removed).toBe(true);
    expect(removed).toBe(true);
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedByPlayerId).toBe(h.seed.ownerPlayerId);
    await assertAuditRow(h, { action: 'server.delete', resource: 'server', targetId: id });
  });
});

describe('RBAC enforcement on /api/v1/servers', () => {
  it('viewer role cannot create servers', async () => {
    const ownerCookie = await login();
    // Demote the owner by replacing their Owner role with Viewer.
    const viewerRoleRows = await h.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, 'Viewer'))
      .limit(1);
    const viewerRoleId = viewerRoleRows[0]?.id;
    if (!viewerRoleId || !h.seed.ownerSteamId64) throw new Error('roles missing');
    await h.db
      .update(players)
      .set({ roleId: viewerRoleId })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    if (!h.seed.ownerPlayerId)
      throw new Error('seed owner missing; pass seedOwner to buildIntegrationApp');
    invalidatePermissionCache(h.seed.ownerPlayerId);

    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: createBody,
    });
    expect(resp.statusCode).toBe(403);
    // Owner cookie should still fail too because the permission cache was
    // refreshed on the second login; at worst both are 403.
    expect(ownerCookie.length).toBeGreaterThan(0);
  });
});
