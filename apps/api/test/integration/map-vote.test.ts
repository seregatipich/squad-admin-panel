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
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const RUN_TAG = Date.now().toString(36);
const LAYER_A = `MV1TestLayer_Alpha_${RUN_TAG}`;
const LAYER_B = `MV1TestLayer_Bravo_${RUN_TAG}`;
const LAYER_DEPRECATED = `MV1TestLayer_Deprecated_${RUN_TAG}`;
const LAYER_UNKNOWN = `MV1TestLayer_Unknown_${RUN_TAG}`;

let h: IntegrationHarness;
let ownerRoleId: string;
let serverId: string;
const createdRoleIds: string[] = [];

// One app + database per file. Each test gets its own server, so candidates,
// settings, matches, picks, config_versions history and audit rows (all keyed
// by server id) never leak between tests. The owner is put back on Owner after
// asRoleWithSquadPermissions(), and the catalog layers are re-seeded because
// one test deletes a layer to simulate it leaving the catalog.
beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID }, seedOwnerGuard: true });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing');
  ownerRoleId = ownerRole.id;
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  for (const id of createdRoleIds.splice(0)) {
    await h.db.delete(roles).where(eq(roles.id, id));
  }
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded in beforeAll
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Map Vote Test Server',
    slug: `map-vote-test-${serverId}`,
  });
  await h.db.insert(serverSettings).values({
    serverId,
    installPath: '/srv/squad/map-vote-test',
    gamePort: 27100,
    queryPort: 27101,
    beaconPort: 27102,
    rconPort: 27103,
  });
  await h.db
    .insert(layers)
    .values([
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
    ])
    .onConflictDoNothing({ target: layers.name });
});

async function asRoleWithSquadPermissions(
  keys: string[],
  opts: { panelAccess?: boolean } = {},
): Promise<string> {
  const roleId = uuidv7();
  createdRoleIds.push(roleId);
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

async function putSettings(
  cookie: string,
  overrides: Partial<{
    enabled: boolean;
    selection: string;
    layer_cooldown: number;
    map_cooldown: number;
    broadcast_template: string | null;
  }> = {},
) {
  return h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${serverId}/map-vote/settings`,
    headers: { cookie },
    payload: {
      enabled: true,
      selection: 'weighted_random',
      layer_cooldown: 3,
      map_cooldown: 2,
      broadcast_template: null,
      ...overrides,
    },
  });
}

async function listVersions(cookie: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/servers/${serverId}/map-vote/versions`,
    headers: { cookie },
  });
}

async function putCandidates(
  cookie: string,
  candidates: Array<{ layer: string; weight: number; enabled: boolean }>,
  confirmDeprecated?: boolean,
) {
  return h.app.inject({
    method: 'PUT',
    url: `/api/v1/servers/${serverId}/map-vote/candidates`,
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
      url: `/api/v1/servers/${serverId}/map-vote`,
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
      url: `/api/v1/servers/${serverId}/map-vote/settings`,
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
      url: `/api/v1/servers/${serverId}/map-vote`,
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
      url: `/api/v1/servers/${serverId}/map-vote/settings`,
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
      targetId: serverId,
    });
    expect(settingsAudit.afterSnapshot).toMatchObject({ enabled: true });

    await putCandidates(cookie, [{ layer: LAYER_A, weight: 1, enabled: true }]);
    const candidatesAudit = await assertAuditRow(h, {
      action: 'server.map_vote.candidates.write',
      resource: 'server',
      targetId: serverId,
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
      serverId,
      layer: LAYER_A,
      map: 'MV1 Test Map A',
      gameMode: 'RAAS',
      startedAt: new Date('2026-07-20T10:00:00.000Z'),
    });

    const first = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote/preview`,
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
      url: `/api/v1/servers/${serverId}/map-vote/preview`,
      headers: { cookie },
    });
    expect(second.json()).toEqual(body);
  });

  it('GET picks returns recorded picks newest first', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const matchId = uuidv7();
    await h.db.insert(matches).values({
      id: matchId,
      serverId,
      layer: LAYER_A,
      map: 'MV1 Test Map A',
      gameMode: 'RAAS',
      startedAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    await h.db.insert(mapVotePicks).values({
      serverId,
      matchId,
      layer: LAYER_B,
      selection: 'weighted_random',
      candidateSnapshot: [],
      rngSeed: matchId,
      applied: true,
    });

    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote/picks?limit=5`,
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
      url: `/api/v1/servers/${serverId}/map-vote`,
    });
    expect(unauthGet.statusCode).toBe(401);

    const noPanelCookie = await asRoleWithSquadPermissions([], { panelAccess: false });
    const forbiddenGet = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote`,
      headers: { cookie: noPanelCookie },
    });
    expect(forbiddenGet.statusCode).toBe(403);

    const noChangemapCookie = await asRoleWithSquadPermissions([]);
    const forbiddenPut = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/map-vote/settings`,
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
      url: `/api/v1/servers/${serverId}/map-vote`,
      headers: { cookie: noChangemapCookie },
    });
    expect(viewerGet.statusCode).toBe(200);
    expect(viewerGet.json().can_edit).toBe(false);
  });
});

describeIfDb('map-vote history in config_versions', () => {
  it('versions every save into the same table the config editor uses, and skips no-op saves', async () => {
    const cookie = await loginAsOwner(h);

    const first = await putCandidates(cookie, [{ layer: LAYER_A, weight: 3, enabled: true }]);
    expect(first.statusCode).toBe(200);
    await putSettings(cookie, { layer_cooldown: 5 });

    const listed = await listVersions(cookie);
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{
      filename: string;
      can_restore: boolean;
      versions: Array<{
        id: string;
        sha256: string;
        parent_version_id: string | null;
        message: string | null;
      }>;
    }>();
    expect(body.filename).toBe('map-vote.json');
    expect(body.can_restore).toBe(true);
    expect(body.versions).toHaveLength(2);
    // Newest first, chained to its predecessor exactly like a .cfg history.
    expect(body.versions[0]?.parent_version_id).toBe(body.versions[1]?.id);
    expect(body.versions[0]?.message).toMatch(/автовыбор/i);
    expect(body.versions[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The screen posts the whole form on every click; an identical save must
    // not pad the history with a second, indistinguishable entry.
    await putSettings(cookie, { layer_cooldown: 5 });
    const afterNoop = await listVersions(cookie);
    expect(afterNoop.json().versions).toHaveLength(2);

    // The rows stay out of the config editor's own surface.
    const configHistory = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/configs/map-vote.json/history`,
      headers: { cookie },
    });
    expect(configHistory.statusCode).not.toBe(200);
  });

  it('serves one version and restores it, re-versioning the rollback', async () => {
    const cookie = await loginAsOwner(h);
    await putCandidates(cookie, [
      { layer: LAYER_A, weight: 3, enabled: true },
      { layer: LAYER_B, weight: 1, enabled: true },
    ]);
    await putSettings(cookie, { layer_cooldown: 7 });
    const original = (await listVersions(cookie)).json().versions[0].id;

    await putCandidates(cookie, [{ layer: LAYER_B, weight: 9, enabled: false }]);
    await putSettings(cookie, { layer_cooldown: 1, enabled: false });

    const one = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${original}`,
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().snapshot).toMatchObject({ layer_cooldown: 7, enabled: true });
    expect(one.json().snapshot.candidates).toHaveLength(2);

    const restored = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${original}/restore`,
      headers: { cookie },
      payload: {},
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ ok: true, count: 2, dropped_layers: [] });

    const current = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote`,
      headers: { cookie },
    });
    const state = current.json();
    expect(state).toMatchObject({ enabled: true, layer_cooldown: 7 });
    expect(state.candidates.map((c: { layer: string }) => c.layer).sort()).toEqual(
      [LAYER_A, LAYER_B].sort(),
    );

    // The rollback is itself an entry, so the history never loses a step.
    const after = await listVersions(cookie);
    expect(after.json().versions[0].message).toMatch(/откат/i);
    await assertAuditRow(h, {
      action: 'server.map_vote.restore',
      resource: 'server',
      targetId: serverId,
    });
  });

  it('refuses to restore a version whose layer left the catalog until it is dropped explicitly', async () => {
    const cookie = await loginAsOwner(h);
    await putCandidates(cookie, [
      { layer: LAYER_A, weight: 1, enabled: true },
      { layer: LAYER_B, weight: 1, enabled: true },
    ]);
    const versionId = (await listVersions(cookie)).json().versions[0].id;

    await putCandidates(cookie, [{ layer: LAYER_A, weight: 1, enabled: true }]);
    await h.db.delete(layers).where(eq(layers.name, LAYER_B));

    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${versionId}/restore`,
      headers: { cookie },
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'unknown_layers_in_version', layers: [LAYER_B] });

    const forced = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${versionId}/restore`,
      headers: { cookie },
      payload: { drop_unknown_layers: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ count: 1, dropped_layers: [LAYER_B] });
  });

  it('lets a viewer read the history but not restore it', async () => {
    const owner = await loginAsOwner(h);
    await putCandidates(owner, [{ layer: LAYER_A, weight: 1, enabled: true }]);
    const versionId = (await listVersions(owner)).json().versions[0].id;

    const viewer = await asRoleWithSquadPermissions([]);
    const read = await listVersions(viewer);
    expect(read.statusCode).toBe(200);
    expect(read.json().can_restore).toBe(false);

    const denied = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${versionId}/restore`,
      headers: { cookie: viewer },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: 'forbidden',
      required_squad_permission: 'changemap',
    });
  });

  it('404s for a version id that belongs to another server or file', async () => {
    const cookie = await loginAsOwner(h);
    await putCandidates(cookie, [{ layer: LAYER_A, weight: 1, enabled: true }]);
    const missing = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/map-vote/versions/${uuidv7()}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'version_not_found' });
  });
});
