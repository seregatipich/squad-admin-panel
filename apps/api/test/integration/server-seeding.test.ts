import { players, roleSquadPermissions, roles, serverSettings } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

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
let ownerRoleId: string;
let SERVER_ID: string;
let createdSeeding: { seedLiveAt: number; seedHysteresis: number };

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    seedOwnerGuard: true,
    bridge: makeFakeBridge(),
  });
  const [ownerRole] = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  if (!ownerRole) throw new Error('Owner role missing — migration 0009 not applied?');
  ownerRoleId = ownerRole.id;

  const cookie = await loginAsOwner(h);
  const create = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: createBody,
  });
  expect(create.statusCode).toBe(201);
  SERVER_ID = create.json<{ id: string }>().id;
  const [settings] = await h.db
    .select({
      seedLiveAt: serverSettings.seedLiveAt,
      seedHysteresis: serverSettings.seedHysteresis,
    })
    .from(serverSettings)
    .where(eq(serverSettings.serverId, SERVER_ID));
  if (!settings) throw new Error('server_settings row missing for the fixture server');
  createdSeeding = settings;
});

afterAll(async () => {
  await h.cleanup();
});

// Cases write the seeding settings (the audit case expects the as-created
// values in its before-snapshot), set the seeding Redis state, and move the
// seeded owner to a narrow role; undo all three.
afterEach(async () => {
  await h.db
    .update(serverSettings)
    .set(createdSeeding)
    .where(eq(serverSettings.serverId, SERVER_ID));
  await h.redis.del(`seeding:state:${SERVER_ID}`);
  await h.db
    .update(players)
    .set({ roleId: ownerRoleId })
    .where(eq(players.steamId64, OWNER_STEAM_ID));
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
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
  await h.db.update(players).set({ roleId }).where(eq(players.steamId64, h.seed.ownerSteamId64!));
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

  // #332: the Redis value is untrusted input — a shape that doesn't match
  // the schema (e.g. `state` outside the seeding/live union) must degrade to
  // state=unknown instead of leaking an arbitrary value into the response.
  it('returns state=unknown for a value with an out-of-union state', async () => {
    await h.redis.set(`seeding:state:${SERVER_ID}`, JSON.stringify({ state: 'corrupted' }));
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

  // #328: worker-rcon's live→seeding transition needs
  // `playerCount < liveAt - hysteresis`; hysteresis >= live_at makes that
  // threshold <= 0, so the server can never drop back into seeding.
  it('rejects seed_hysteresis >= seed_live_at even though both pass their own bounds (400)', async () => {
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 10, seed_hysteresis: 20 },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toEqual({ error: 'hysteresis_must_be_below_live_at' });
  });

  it('rejects a partial update that would make hysteresis >= the current live_at (400)', async () => {
    const cookie = await loginAsOwner(h);
    const seeded = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_live_at: 30, seed_hysteresis: 5 },
    });
    expect(seeded.statusCode).toBe(200);

    const resp = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${SERVER_ID}/seeding-settings`,
      headers: { cookie },
      payload: { seed_hysteresis: 30 },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toEqual({ error: 'hysteresis_must_be_below_live_at' });
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
