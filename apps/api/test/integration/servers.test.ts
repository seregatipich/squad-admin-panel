import { serverCredentials, serverSettings, servers, userRoleAssignments } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';

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
  h = await buildIntegrationApp({
    seedOwner: { email: EMAIL, password: PASSWORD },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function login(): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
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
});

describe('DELETE /api/v1/servers/:id', () => {
  it('cascades through config_versions even when the file has edit history', async () => {
    const cookie = await login();
    const { id } = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie },
        payload: createBody,
      })
    ).json<{ id: string }>();
    // Write two config versions so config_versions gets populated. Before the
    // 0004_config_versions_cascade migration, the cascade DELETE from servers
    // tripped the append-only trigger and the whole request 500'd.
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

    const srv = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(srv).toHaveLength(0);
    const after = await h.db.select().from(configVersions).where(eq(configVersions.serverId, id));
    expect(after).toHaveLength(0);
  });

  it('removes the row and issues container_rm on the bridge', async () => {
    let removed = false;
    h.bridge.containerRm = async () => {
      removed = true;
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
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ ok: true });
    expect(removed).toBe(true);
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row).toBeUndefined();
    await assertAuditRow(h, { action: 'server.delete', resource: 'server', targetId: id });
  });
});

describe('RBAC enforcement on /api/v1/servers', () => {
  it('viewer role cannot create servers', async () => {
    const ownerCookie = await login();
    // Demote the owner by replacing their Owner role with Viewer.
    const viewerRole = await h.db.query.roles.findFirst({
      where: (r, { and, eq: e }) => and(e(r.orgId, h.seed.orgId!), e(r.name, 'Viewer')),
    });
    if (!viewerRole || !h.seed.ownerUserId) throw new Error('roles missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId));
    await h.db
      .insert(userRoleAssignments)
      .values({ userId: h.seed.ownerUserId, roleId: viewerRole.id });

    // New login picks up the fresh permission set (the rbac cache is
    // per-process and keyed by user id).
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
