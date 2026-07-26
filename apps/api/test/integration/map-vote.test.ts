import {
  layers,
  mapVotePicks,
  matches,
  players,
  roleSquadPermissions,
  roles,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(80000);
const SERVER_ID = '019f8100-0000-7000-8000-000000000001';
const RUN_TAG = Date.now().toString(36);
const LAYER_A = `MV1TestLayer_Alpha_${RUN_TAG}`;
const LAYER_B = `MV1TestLayer_Bravo_${RUN_TAG}`;
const LAYER_DEPRECATED = `MV1TestLayer_Deprecated_${RUN_TAG}`;
const LAYER_UNKNOWN = `MV1TestLayer_Unknown_${RUN_TAG}`;

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
  await h.db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Map Vote Test Server',
    slug: 'map-vote-test-server',
  });
  await h.db.insert(serverSettings).values({
    serverId: SERVER_ID,
    installPath: '/srv/squad/map-vote-test',
    gamePort: 27100,
    queryPort: 27101,
    beaconPort: 27102,
    rconPort: 27103,
  });
  await h.db.insert(layers).values([
    {
      id: uuidv7(),
      name: LAYER_A,
      map: 'MV1 Test Map A',
      gamemode: 'RAAS',
      version: 'v1',
      isSeed: false,
      teams: {},
    },
    {
      id: uuidv7(),
      name: LAYER_B,
      map: 'MV1 Test Map B',
      gamemode: 'AAS',
      version: 'v1',
      isSeed: false,
      teams: {},
    },
    {
      id: uuidv7(),
      name: LAYER_DEPRECATED,
      map: 'MV1 Test Map C',
      gamemode: 'Invasion',
      version: 'v1',
      isSeed: false,
      teams: {},
      deprecated: true,
    },
  ]);
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function asRoleWithSquadPermissions(
  keys: string[],
  opts: { panelAccess?: boolean } = {},
): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      // Full uuid, not a slice(0, 8) prefix: uuidv7 prefixes are timestamp-based
      // and collide for roles created within the same test (#220 flake class).
      name: `MapVote-${keys.join('-') || 'none'}-${roleId}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: opts.panelAccess ?? true,
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

async function putCandidates(
  cookie: string,
  candidates: Array<{ layer: string; weight: number; enabled: boolean }>,
  confirmDeprecated?: boolean,
) {
  return h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${SERVER_ID}/map-vote/candidates`,
    headers: { cookie },
    payload: { candidates, confirm_deprecated: confirmDeprecated },
  });
}

describeIfDb('server map-vote routes', () => {
  it('PUT candidates persists and GET returns them enriched', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    const put = await putCandidates(cookie, [
      { layer: LAYER_A, weight: 3, enabled: true },
      { layer: LAYER_B, weight: 7, enabled: false },
    ]);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true, count: 2 });

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body).toMatchObject({
      enabled: false,
      selection: 'weighted_random',
      layer_cooldown: 3,
      map_cooldown: 2,
      broadcast_template: null,
      can_edit: true,
    });
    expect(body.candidates).toEqual([
      expect.objectContaining({
        layer: LAYER_A,
        map: 'MV1 Test Map A',
        gamemode: 'RAAS',
        weight: 3,
        enabled: true,
        deprecated: false,
      }),
      expect.objectContaining({
        layer: LAYER_B,
        map: 'MV1 Test Map B',
        gamemode: 'AAS',
        weight: 7,
        enabled: false,
        deprecated: false,
      }),
    ]);
  });

  it('PUT candidates with unknown layer → 404 unknown_layer', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const resp = await putCandidates(cookie, [{ layer: LAYER_UNKNOWN, weight: 1, enabled: true }]);
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toMatchObject({ error: 'unknown_layer', layer: LAYER_UNKNOWN });
  });

  it('PUT candidates with deprecated layer without confirm → 409', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const denied = await putCandidates(cookie, [
      { layer: LAYER_DEPRECATED, weight: 1, enabled: true },
    ]);
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: 'deprecated_layer_confirmation_required' });

    const confirmed = await putCandidates(
      cookie,
      [{ layer: LAYER_DEPRECATED, weight: 1, enabled: true }],
      true,
    );
    expect(confirmed.statusCode).toBe(200);
  });

  it('PUT settings persists the map-vote configuration', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/settings`,
      headers: { cookie },
      payload: {
        enabled: true,
        selection: 'least_recently_played',
        layer_cooldown: 5,
        map_cooldown: 1,
        broadcast_template: 'Следующая карта: {layer}',
      },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ ok: true });

    const get = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote`,
      headers: { cookie },
    });
    expect(get.json()).toMatchObject({
      enabled: true,
      selection: 'least_recently_played',
      layer_cooldown: 5,
      map_cooldown: 1,
      broadcast_template: 'Следующая карта: {layer}',
    });
  });

  it('writes audit rows for settings and candidates mutations', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/settings`,
      headers: { cookie },
      payload: {
        enabled: true,
        selection: 'weighted_random',
        layer_cooldown: 3,
        map_cooldown: 2,
        broadcast_template: null,
      },
    });
    const settingsAudit = await assertAuditRow(h, {
      action: 'server.map_vote.settings.write',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(settingsAudit.afterSnapshot).toMatchObject({ enabled: true });

    await putCandidates(cookie, [{ layer: LAYER_A, weight: 1, enabled: true }]);
    const candidatesAudit = await assertAuditRow(h, {
      action: 'server.map_vote.candidates.write',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(candidatesAudit.afterSnapshot).toMatchObject({ count: 1 });
  });

  it('preview returns eligible pool and a deterministic would_pick', async () => {
    const cookie = await asRoleWithSquadPermissions(['changemap']);
    await putCandidates(cookie, [
      { layer: LAYER_A, weight: 1, enabled: true },
      { layer: LAYER_B, weight: 3, enabled: true },
    ]);
    await h.db.insert(matches).values({
      serverId: SERVER_ID,
      layer: LAYER_A,
      map: 'MV1 Test Map A',
      gameMode: 'RAAS',
      startedAt: new Date('2026-07-20T10:00:00.000Z'),
    });

    const first = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/preview`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    // LAYER_A is within the default layer cooldown (last match); LAYER_B remains.
    expect(body.excluded).toEqual([{ layer: LAYER_A, reason: 'layer_cooldown' }]);
    expect(body.eligible).toEqual([{ layer: LAYER_B, weight: 3, probability: 1 }]);
    expect(body.would_pick).toBe(LAYER_B);

    const second = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/preview`,
      headers: { cookie },
    });
    expect(second.json()).toEqual(body);
  });

  it('GET picks returns recorded picks newest first', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const matchId = uuidv7();
    await h.db.insert(matches).values({
      id: matchId,
      serverId: SERVER_ID,
      layer: LAYER_A,
      map: 'MV1 Test Map A',
      gameMode: 'RAAS',
      startedAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    await h.db.insert(mapVotePicks).values({
      serverId: SERVER_ID,
      matchId,
      layer: LAYER_B,
      selection: 'weighted_random',
      candidateSnapshot: [],
      rngSeed: matchId,
      applied: true,
    });

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/picks?limit=5`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().picks).toEqual([
      expect.objectContaining({
        match_id: matchId,
        layer: LAYER_B,
        selection: 'weighted_random',
        applied: true,
        failure_reason: null,
      }),
    ]);
  });

  it('reads require panelAccess; writes require changemap', async () => {
    const unauthGet = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote`,
    });
    expect(unauthGet.statusCode).toBe(401);

    const noPanelCookie = await asRoleWithSquadPermissions([], { panelAccess: false });
    const forbiddenGet = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote`,
      headers: { cookie: noPanelCookie },
    });
    expect(forbiddenGet.statusCode).toBe(403);

    const noChangemapCookie = await asRoleWithSquadPermissions([]);
    const forbiddenPut = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/map-vote/settings`,
      headers: { cookie: noChangemapCookie },
      payload: {
        enabled: false,
        selection: 'weighted_random',
        layer_cooldown: 3,
        map_cooldown: 2,
        broadcast_template: null,
      },
    });
    expect(forbiddenPut.statusCode).toBe(403);
    expect(forbiddenPut.json()).toMatchObject({
      error: 'forbidden',
      required_squad_permission: 'changemap',
    });

    const forbiddenCandidates = await putCandidates(noChangemapCookie, [
      { layer: LAYER_A, weight: 1, enabled: true },
    ]);
    expect(forbiddenCandidates.statusCode).toBe(403);

    const viewerGet = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/map-vote`,
      headers: { cookie: noChangemapCookie },
    });
    expect(viewerGet.statusCode).toBe(200);
    expect(viewerGet.json().can_edit).toBe(false);
  });
});
