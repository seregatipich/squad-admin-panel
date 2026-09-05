import { serverCredentials, serverSettings, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, deserialize } from '../../src/lib/crypto.js';
import { relaunchSidecar } from '../../src/lib/rnsquadjs.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// start/restart relaunch the sidecar through real fs writes; the container
// routes must never get that far for an external server, but the stub keeps
// the module import side-effect free either way.
vi.mock('../../src/lib/rnsquadjs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rnsquadjs.js')>()),
  relaunchSidecar: vi.fn().mockResolvedValue({ containerId: 'rnsquadjs-test', mode: 'shadow' }),
}));

const OWNER_STEAM_ID = 76561198000000777n;

const externalBody = {
  display_name: 'RAAS/AAS #1',
  slug: 'raas-1',
  description: 'hosted by the community box',
  rcon_host: '203.0.113.10',
  rcon_port: 21_114,
  rcon_password: 'remote-rcon-secret',
  query_port: 27_165,
  game_port: 7787,
  max_players: 100,
};

const containerBody = {
  display_name: 'Panel Box',
  slug: 'panel-box',
  game_port: 7787,
  query_port: 27_165,
  beacon_port: 15_000,
  rcon_port: 21_114,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;
let bridgeCalls: string[];

beforeEach(async () => {
  bridgeCalls = [];
  const bridge = makeFakeBridge();
  // Record every container/bridge touch so a test can prove an external
  // server never reaches the host bridge.
  for (const method of [
    'containerInspect',
    'containerStats',
    'containerStart',
    'containerStop',
    'containerRm',
    'containerRun',
    'fileRead',
    'directoryDelete',
    'ufwRule',
    'hostInfo',
  ] as const) {
    const original = bridge[method] as (...args: unknown[]) => Promise<unknown>;
    (bridge as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      bridgeCalls.push(method);
      return original(...args);
    };
  }
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge,
    withStatusReconciler: true,
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function createExternal(cookie: string, overrides: Partial<typeof externalBody> = {}) {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers/external',
    headers: { cookie },
    payload: { ...externalBody, ...overrides },
  });
  expect(resp.statusCode).toBe(201);
  return resp.json<{ id: string; status: string; runtime: string }>();
}

describe('POST /api/v1/servers/external', () => {
  it('registers a running external row with the given RCON host and encrypted password', async () => {
    const cookie = await loginAsOwner(h);
    const created = await createExternal(cookie);
    expect(created).toMatchObject({ status: 'running', runtime: 'external' });

    const [row] = await h.db.select().from(servers).where(eq(servers.id, created.id));
    expect(row?.runtime).toBe('external');
    expect(row?.status).toBe('running');
    expect(row?.slug).toBe('raas-1');

    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, created.id));
    expect(creds?.rconHost).toBe('203.0.113.10');
    expect(creds?.rconPort).toBe(21_114);
    const stored = decryptString(
      h.app.encryptionKey,
      deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
    );
    expect(stored).toBe('remote-rcon-secret');

    const [settings] = await h.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, created.id));
    expect(settings?.queryPort).toBe(27_165);
    expect(settings?.gamePort).toBe(7787);
    expect(settings?.rconPort).toBe(21_114);
    expect(settings?.maxPlayers).toBe(100);

    expect(bridgeCalls).toEqual([]);
    await assertAuditRow(h, { action: 'server.create_external', resource: 'server' });
  });

  it('does not collide with a panel-hosted server that uses the same default ports', async () => {
    const cookie = await loginAsOwner(h);
    const local = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: containerBody,
    });
    expect(local.statusCode).toBe(201);

    // Same 7787/27165/21114 triple as the local container — a different host.
    await createExternal(cookie);

    // And the reverse: a container after an external row on the same ports.
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        ...containerBody,
        slug: 'panel-box-2',
        game_port: 7797,
        query_port: 27175,
        beacon_port: 15010,
        rcon_port: 21124,
      },
    });
    expect(second.statusCode).toBe(201);
    const third = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: {
        ...containerBody,
        slug: 'panel-box-3',
        game_port: 7807,
        query_port: 27185,
        beacon_port: 15020,
        rcon_port: 21134,
      },
    });
    expect(third.statusCode).toBe(201);
  });

  it('answers 409 slug_in_use for a duplicate slug and 400 for a missing password', async () => {
    const cookie = await loginAsOwner(h);
    await createExternal(cookie);
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers/external',
      headers: { cookie },
      payload: externalBody,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'slug_in_use' });

    const { rcon_password: _omitted, ...noPassword } = externalBody;
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers/external',
      headers: { cookie },
      payload: { ...noPassword, slug: 'raas-2' },
    });
    expect([400, 422]).toContain(bad.statusCode);
  });
});

describe('reading an external server', () => {
  it('lists it with runtime=external and merges the worker-rcon status key', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    await h.redis.set(
      `rcon:status:${id}`,
      JSON.stringify({
        state: 'connected',
        player_count: 32,
        last_poll_at: '2026-09-05T12:00:00Z',
      }),
    );
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/servers', headers: { cookie } });
    expect(resp.statusCode).toBe(200);
    const item = resp
      .json<{ items: Array<Record<string, unknown>> }>()
      .items.find((s) => s.id === id);
    expect(item).toMatchObject({
      runtime: 'external',
      status: 'running',
      rcon_state: 'connected',
      player_count: 32,
    });
  });

  it('detail skips the bridge and reports the RCON host as the address', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    bridgeCalls.length = 0;
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{
      server: { runtime: string; status: string };
      container: unknown;
      host: { address: string; hostname: string } | null;
      connection: { rcon_host: string | null; rcon_port: number | null } | null;
      settings: { rcon_port: number; query_port: number };
    }>();
    expect(body.server.runtime).toBe('external');
    expect(body.container).toBeNull();
    expect(body.host).toEqual({ address: '203.0.113.10', hostname: '203.0.113.10' });
    expect(body.connection).toEqual({ rcon_host: '203.0.113.10', rcon_port: 21_114 });
    expect(bridgeCalls).toEqual([]);
  });
});

describe('container-only operations on an external server', () => {
  it.each([
    ['POST', '/start'],
    ['POST', '/stop'],
    ['POST', '/restart'],
    ['POST', '/force-stop'],
    ['POST', '/install'],
    ['POST', '/update'],
    ['POST', '/reconcile'],
    ['GET', '/configs'],
    ['GET', '/configs/Server.cfg'],
    ['GET', '/rotation'],
    ['GET', '/metrics'],
    ['GET', '/logs/files'],
    ['GET', '/rnsquadjs'],
  ] as const)(
    '%s /api/v1/servers/:id%s answers 409 external_server without touching the bridge',
    async (method, suffix) => {
      const cookie = await loginAsOwner(h);
      const { id } = await createExternal(cookie);
      bridgeCalls.length = 0;
      const resp = await h.app.inject({
        method,
        url: `/api/v1/servers/${id}${suffix}`,
        headers: { cookie },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json()).toMatchObject({ error: 'external_server' });
      expect(bridgeCalls).toEqual([]);

      const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
      expect(row?.status).toBe('running');
    },
  );

  it('keeps 404 semantics for an unknown id on a guarded route', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/0192a1b2-0000-7000-8000-0000000000ff/configs',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });

  it('PUT /settings refuses a port change but still saves non-port fields', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    const ports = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/settings`,
      headers: { cookie },
      payload: { rcon_port: 21_115 },
    });
    expect(ports.statusCode).toBe(409);
    expect(ports.json()).toMatchObject({ error: 'external_server' });

    const rules = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/settings`,
      headers: { cookie },
      payload: { chat_commands_enabled: false, rules_text: 'no teamkilling' },
    });
    expect(rules.statusCode).toBe(200);
    const [settings] = await h.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, id));
    expect(settings?.chatCommandsEnabled).toBe(false);
    expect(settings?.rulesText).toBe('no teamkilling');
  });
});

describe('status reconciler and external servers', () => {
  it('a tick leaves an external row running even though no container exists', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    h.bridge.containerInspect = async ({ name }) => ({
      name,
      state: 'not_found',
      running: false,
      pid: 0,
      started_at: '',
      finished_at: '',
      exit_code: 0,
      image: '',
      restart_count: 0,
      labels: {},
    });
    bridgeCalls.length = 0;
    await h.app.statusReconciler.tickNow();
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('running');
    expect(bridgeCalls.filter((c) => c === 'containerInspect')).toEqual([]);
  });

  it('reconcileOnce does not flip an external row either', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    const result = await h.app.statusReconciler.reconcileOnce(id);
    expect(result).toBeNull();
    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe('running');
  });
});

describe('PUT /api/v1/servers/:id/external-connection', () => {
  it('repoints host/port/password and the A2S/game ports', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/external-connection`,
      headers: { cookie },
      payload: {
        rcon_host: 'squad.example.org',
        rcon_port: 21_200,
        rcon_password: 'rotated',
        query_port: 27_200,
        game_port: 7800,
        max_players: 98,
      },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      id,
      rcon_host: 'squad.example.org',
      rcon_port: 21_200,
      query_port: 27_200,
      game_port: 7800,
      max_players: 98,
      password_updated: true,
    });
    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(creds?.rconHost).toBe('squad.example.org');
    expect(creds?.rconPort).toBe(21_200);
    expect(
      decryptString(
        h.app.encryptionKey,
        deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
      ),
    ).toBe('rotated');
    const [settings] = await h.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, id));
    expect(settings?.rconPort).toBe(21_200);
    expect(settings?.queryPort).toBe(27_200);
    expect(settings?.gamePort).toBe(7800);
    expect(settings?.maxPlayers).toBe(98);
    await assertAuditRow(h, {
      action: 'server.update_external_connection',
      resource: 'server',
      targetId: id,
    });
  });

  it('keeps the stored password when the body omits it', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/external-connection`,
      headers: { cookie },
      payload: { rcon_port: 21_300 },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ rcon_port: 21_300, password_updated: false });
    const [creds] = await h.db
      .select()
      .from(serverCredentials)
      .where(eq(serverCredentials.serverId, id));
    expect(
      decryptString(
        h.app.encryptionKey,
        deserialize(Buffer.from(creds?.rconPasswordEncrypted as unknown as Buffer)),
      ),
    ).toBe('remote-rcon-secret');
  });

  it('answers 409 not_external_server for a panel-hosted row and 400 for an empty body', async () => {
    const cookie = await loginAsOwner(h);
    const local = await h.app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { cookie },
      payload: containerBody,
    });
    const localId = local.json<{ id: string }>().id;
    const refused = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${localId}/external-connection`,
      headers: { cookie },
      payload: { rcon_port: 21_400 },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'not_external_server' });

    const { id } = await createExternal(cookie);
    const empty = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${id}/external-connection`,
      headers: { cookie },
      payload: {},
    });
    expect([400, 422]).toContain(empty.statusCode);
  });
});

describe('DELETE /api/v1/servers/:id for an external server', () => {
  it('soft-deletes the row without any bridge call and without a config backup', async () => {
    const cookie = await loginAsOwner(h);
    const { id } = await createExternal(cookie);
    bridgeCalls.length = 0;
    const resp = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({
      files_backed_up: 0,
      files_attempted: 0,
      backup_marker_id: null,
      container_removed: false,
      ufw_rules_removed: 0,
      errors: [],
    });
    expect(bridgeCalls).toEqual([]);

    const [row] = await h.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.deletedAt).not.toBeNull();

    const gone = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${id}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
    expect(vi.mocked(relaunchSidecar)).not.toHaveBeenCalled();
  });
});
