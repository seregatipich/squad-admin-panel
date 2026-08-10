import { players, roleSquadPermissions, roles, serverSettings } from '@squad/db/schema';
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
  makeFakeBridge,
} from './harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM_ID = testSteamId(188000);

const createBody = {
  display_name: 'Seeding Test Server',
  slug: 'seeding-test-server',
  description: 'integration fixture',
  game_port: 7788,
  query_port: 27166,
  beacon_port: 15001,
  rcon_port: 21115,
  max_players: 80,
  tickrate: 50,
  multihome: '0.0.0.0',
  extra_args: '',
};

let h: IntegrationHarness;
let SERVER_ID: string;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  const cookie = await loginAsOwner(h);
  const create = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: createBody,
  });
  expect(create.statusCode).toBe(201);
  SERVER_ID = create.json<{ id: string }>().id;
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

/**
 * Repurposes the seeded owner's role to a fresh non-system role granting
 * exactly `keys` squad permissions (mirrors the pattern in
 * server-messaging.test.ts). Returns a fresh session cookie for that role.
 */
async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `Seeding-${keys.join('-') || 'none'}-${roleId}`,
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

describeIfDb('GET /api/v1/servers/:id/seeding', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({ method: 'GET', url: `/api/v1/servers/${SERVER_ID}/seeding` });
    expect(resp.statusCode).toBe(401);
  });

  it('returns state=unknown with nulls when no seeding redis key is set', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/seeding`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      state: 'unknown',
      current_players: null,
      live_at: null,
      progress_pct: null,
      started_at: null,
    });
  });

  it('returns the parsed state once the redis key is set', async () => {
    await h.redis.set(
      `seeding:state:${SERVER_ID}`,
      JSON.stringify({
        state: 'seeding',
        started_at: '2026-07-14T09:00:00.000Z',
        current_players: 40,
        live_at: 60,
        progress_pct: 66,
        layer: 'Yehorivka RAAS v11',
        updated_at: '2026-07-14T09:05:00.000Z',
      }),
    );
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${SERVER_ID}/seeding`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({
      state: 'seeding',
      current_players: 40,
      live_at: 60,
      progress_pct: 66,
      started_at: '2026-07-14T09:00:00.000Z',
    });
  });

  it('404s for a deleted/unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${uuidv7()}/seeding`,
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describeIfDb('PUT /api/v1/servers/:id/seeding-settings', () => {
  it('rejects an unauthenticated request', async () => {
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      payload: { seed_live_at: 70 },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('403s without the manageserver squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions([]);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 70 },
    });
    expect(resp.statusCode).toBe(403);
    expect(resp.json()).toEqual({ error: 'forbidden', required_squad_permission: 'manageserver' });
  });

  it('succeeds for a user with the manageserver squad permission', async () => {
    const cookie = await asRoleWithSquadPermissions(['manageserver']);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 75, seed_hysteresis: 8 },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toMatchObject({ seed_live_at: 75, seed_hysteresis: 8 });
  });

  it('updates server_settings and writes an audit entry with before/after (Owner)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 90, seed_hysteresis: 10 },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ server_id: SERVER_ID, seed_live_at: 90, seed_hysteresis: 10 });

    const [row] = await h.db
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.serverId, SERVER_ID));
    expect(row?.seedLiveAt).toBe(90);
    expect(row?.seedHysteresis).toBe(10);

    const audit = await assertAuditRow(h, {
      action: 'server.seeding_settings_update',
      resource: 'server',
      targetId: SERVER_ID,
    });
    expect(audit.beforeSnapshot).toMatchObject({ seed_live_at: 60, seed_hysteresis: 5 });
    expect(audit.afterSnapshot).toMatchObject({ seed_live_at: 90, seed_hysteresis: 10 });
  });

  it('rejects seed_live_at = 0 (400)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 0 },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('rejects a negative seed_hysteresis (400)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_hysteresis: -1 },
    });
    expect(resp.statusCode).toBe(400);
  });

  it('404s for a deleted/unknown server', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${uuidv7()}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 70 },
    });
    expect(resp.statusCode).toBe(404);
  });
});

describeIfDb('GET /api/v1/servers includes seeding', () => {
  it('includes a seeding object per row when the redis key is present', async () => {
    await h.redis.set(
      `seeding:state:${SERVER_ID}`,
      JSON.stringify({
        state: 'seeding',
        started_at: '2026-07-14T09:00:00.000Z',
        current_players: 12,
        live_at: 60,
        progress_pct: 20,
        layer: 'Sumari Seed v1',
        updated_at: '2026-07-14T09:05:00.000Z',
      }),
    );
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const item = resp
      .json<{ items: Array<{ id: string; seeding: unknown }> }>()
      .items.find((i) => i.id === SERVER_ID);
    expect(item?.seeding).toMatchObject({
      state: 'seeding',
      current_players: 12,
      live_at: 60,
      progress_pct: 20,
      started_at: '2026-07-14T09:00:00.000Z',
    });
  });

  it('has seeding=null when there is no redis key', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { cookie },
    });
    const item = resp
      .json<{ items: Array<{ id: string; seeding: unknown }> }>()
      .items.find((i) => i.id === SERVER_ID);
    expect(item?.seeding).toBeNull();
  });
});
