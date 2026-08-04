import { layers, matches, players, roleSquadPermissions, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(187000);
const SERVER_ID = '019e2000-0000-7000-8000-000000000002';
const RUN_TAG = Date.now().toString(36);
const LAYER_ACTIVE = `RM3TestLayer_Active_${RUN_TAG}`;
const LAYER_NEXT = `RM3TestLayer_Next_${RUN_TAG}`;
const LAYER_DEPRECATED = `RM3TestLayer_Deprecated_${RUN_TAG}`;
const LAYER_UNKNOWN = `RM3TestLayer_Unknown_${RUN_TAG}`;

let h: IntegrationHarness;

function okOutcome(overrides: Partial<WorkerRconCommandOutcome> = {}): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-test',
    response: 'ok',
    via: 'worker-rcon',
    ...overrides,
  } as WorkerRconCommandOutcome;
}

function notConnectedOutcome(): WorkerRconCommandOutcome {
  return { attempted: false, reason: 'worker_not_connected' };
}

function rconStatus(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: 'connected',
    ts: '2026-07-14T10:00:00.000Z',
    player_count: 42,
    current_map: LAYER_ACTIVE,
    game_mode: 'RAAS',
    next_layer: LAYER_NEXT,
    ...overrides,
  });
}

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Map Widget Test Server',
    slug: 'map-widget-test-server',
  });
  await h.db.insert(layers).values([
    {
      id: uuidv7(),
      name: LAYER_ACTIVE,
      map: 'RM3 Test Map',
      gamemode: 'RAAS',
      version: 'v1',
      isSeed: false,
      teams: {},
    },
    {
      id: uuidv7(),
      name: LAYER_NEXT,
      map: 'RM3 Test Map 2',
      gamemode: 'AAS',
      version: 'v1',
      isSeed: false,
      teams: {},
    },
    {
      id: uuidv7(),
      name: LAYER_DEPRECATED,
      map: 'RM3 Test Map 3',
      gamemode: 'Invasion',
      version: 'v1',
      isSeed: false,
      teams: {},
      deprecated: true,
    },
  ]);
  vi.mocked(sendRconCommandViaWorker).mockReset();
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `MapWidget-${keys.join('-') || 'none'}-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: true,
    });
    for (const key of keys) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

describeIfDb('GET /api/v1/servers/:serverId/map', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map`,
    });
    expect(resp.statusCode).toBe(401);
  });

  it('returns current/next resolved against the layer catalog, and match_started_at from the open match', async () => {
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus());
    await h.db.insert(matches).values({
      serverId: SERVER_ID,
      layer: LAYER_ACTIVE,
      map: 'RM3 Test Map',
      gameMode: 'RAAS',
      startedAt: new Date('2026-07-14T09:45:00.000Z'),
    });

    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.current).toMatchObject({
      layer: LAYER_ACTIVE,
      map: 'RM3 Test Map',
      gamemode: 'RAAS',
      deprecated: false,
    });
    expect(body.next).toMatchObject({
      layer: LAYER_NEXT,
      map: 'RM3 Test Map 2',
      gamemode: 'AAS',
      deprecated: false,
    });
    expect(body.match_started_at).toBe('2026-07-14T09:45:00.000Z');
  });

  it('returns next: null when ShowNextMap reports no next layer set ("to be voted")', async () => {
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus({ next_layer: undefined }));
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().next).toBeNull();
    expect(resp.json().match_started_at).toBeNull();
  });
});

describeIfDb('POST /api/v1/servers/:serverId/map/next', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      payload: { layer: LAYER_NEXT },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('403s without the changemap squad permission and does not enqueue an RCON command', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_NEXT },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toMatchObject({
      error: 'forbidden',
      required_squad_permission: 'changemap',
    });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('404s for a layer not present in the catalog', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_UNKNOWN },
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toMatchObject({ error: 'unknown_layer' });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('409s for a deprecated layer without confirm_deprecated', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_DEPRECATED },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json()).toMatchObject({ error: 'deprecated_layer_confirmation_required' });
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('enqueues AdminSetNextLayer, writes an audit entry, patches redis, and publishes server.map.changed on success', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus());
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const received: unknown[] = [];
    const unsub = h.app.liveBus.subscribe((event) => received.push(event));

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_NEXT },
    });
    unsub();

    expect(resp.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER_ID,
        command: 'AdminSetNextLayer',
        args: [LAYER_NEXT],
      }),
    );

    const audit = await assertAuditRow(h, {
      action: 'server.map.set_next',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.afterSnapshot).toMatchObject({ layer: LAYER_NEXT });

    const patched = JSON.parse((await h.redis.get(`rcon:status:${SERVER_ID}`)) ?? '{}');
    expect(patched.next_layer).toBe(LAYER_NEXT);

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'server.map.changed',
        data: expect.objectContaining({
          server_id: SERVER_ID,
          action: 'server.map.set_next',
          layer: LAYER_NEXT,
        }),
      }),
    );
  });

  it('accepts a deprecated layer with confirm_deprecated: true', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus());
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_DEPRECATED, confirm_deprecated: true },
    });
    expect(resp.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'AdminSetNextLayer', args: [LAYER_DEPRECATED] }),
    );
  });

  it('502s and writes no audit row when the worker is not connected', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(notConnectedOutcome());
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus());
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/next`,
      headers: { cookie },
      payload: { layer: LAYER_NEXT },
    });
    expect(resp.statusCode).toBe(502);
    expect(resp.json()).toMatchObject({ error: 'rcon_unavailable' });

    await expect(
      assertAuditRow(h, {
        action: 'server.map.set_next',
        resource: 'server',
        targetId: SERVER_ID,
        withinMs: 500,
      }),
    ).rejects.toThrow();
  });
});

describeIfDb('POST /api/v1/servers/:serverId/map/change', () => {
  it('403s without the changemap squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/change`,
      headers: { cookie },
      payload: { layer: LAYER_NEXT },
    });
    expect(resp.statusCode).toBe(403);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('enqueues AdminChangeLayer and writes a server.map.change audit entry on success', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/change`,
      headers: { cookie },
      payload: { layer: LAYER_NEXT },
    });
    expect(resp.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: SERVER_ID,
        command: 'AdminChangeLayer',
        args: [LAYER_NEXT],
      }),
    );

    const audit = await assertAuditRow(h, {
      action: 'server.map.change',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.afterSnapshot).toMatchObject({ layer: LAYER_NEXT });
  });
});

describeIfDb('POST /api/v1/servers/:serverId/map/end-match', () => {
  it('403s without the changemap squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/end-match`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
  });

  it('enqueues AdminEndMatch and writes a server.map.end_match audit entry with the current layer', async () => {
    vi.mocked(sendRconCommandViaWorker).mockResolvedValueOnce(okOutcome());
    await h.redis.set(`rcon:status:${SERVER_ID}`, rconStatus());
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const resp = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${SERVER_ID}/map/end-match`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: SERVER_ID, command: 'AdminEndMatch', args: [] }),
    );

    const audit = await assertAuditRow(h, {
      action: 'server.map.end_match',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.afterSnapshot).toMatchObject({ layer: LAYER_ACTIVE });
  });
});
