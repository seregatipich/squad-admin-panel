import { events, players, roleSquadPermissions, roles } from '@squad/db/schema';
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

const OWNER_STEAM_ID = testSteamId(142000);

// Known-to-catalog seed layers seeded by migration 0042 (static ROT-1 fallback dataset).
const SEED_LAYER_A = 'Sumari Seed v1';
const SEED_LAYER_B = 'Narva Seed v1';
const NON_SEED_LAYER = 'Yehorivka RAAS v11';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function login(): Promise<string> {
  return loginAsOwner(h);
}

async function createServer(cookie: string, slug = 'seed-schedule-server'): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: 'Seed Schedule Server',
      slug,
      game_port: 7787,
      query_port: 27165,
      beacon_port: 15000,
      rcon_port: 21114,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`server create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

/** Demotes the seeded owner to a role with only the given squad permissions. */
async function asRoleWithSquadPermissions(keys: string[]): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `SeedSchedule-${keys.join('-') || 'none'}-${roleId}`,
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

describe('GET /api/v1/servers/:id/seed-schedule', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown server id', async () => {
    const cookie = await login();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019f46a1-0000-7000-8000-000000000000/seed-schedule',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns entries and can_edit=false for a non-changemap user', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRoleWithSquadPermissions([]);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ entries: unknown[]; can_edit: boolean }>();
    expect(body.entries).toEqual([]);
    expect(body.can_edit).toBe(false);
  });
});

describe('POST /api/v1/servers/:id/seed-schedule', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      payload: { starts_at: new Date().toISOString(), seed_layer: SEED_LAYER_A },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a role without changemap', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRoleWithSquadPermissions([]);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: SEED_LAYER_A },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required_squad_permission: 'changemap' });
  });

  it('creates a one-off entry, persists it, and writes an audit row', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: {
        starts_at: startsAt,
        seed_layer: SEED_LAYER_A,
        broadcast_text: 'Заходим сидить!',
        notify_minutes_before: 15,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      seed_layer: string;
      notify_minutes_before: number;
      recurrence: string | null;
    }>();
    expect(body.seed_layer).toBe(SEED_LAYER_A);
    expect(body.notify_minutes_before).toBe(15);
    expect(body.recurrence).toBeNull();

    const listRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
    });
    const listBody = listRes.json<{ entries: { id: string }[]; can_edit: boolean }>();
    expect(listBody.entries.map((e) => e.id)).toContain(body.id);
    expect(listBody.can_edit).toBe(true);

    await assertAuditRow(h, {
      action: 'server.seed_schedule.create',
      resource: 'seed_schedule',
      targetId: body.id,
    });
  });

  it('creates a recurring entry with a valid 5-field cron expression', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: {
        starts_at: new Date().toISOString(),
        seed_layer: SEED_LAYER_B,
        recurrence: '0 10 * * 6',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ recurrence: string }>().recurrence).toBe('0 10 * * 6');
  });

  it('rejects a seed_layer that is not in the catalog', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: 'Not A Real Layer v1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_seed_layer' });
  });

  it('rejects a seed_layer that exists in the catalog but is not is_seed', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: NON_SEED_LAYER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_seed_layer' });
  });

  it('rejects an invalid cron recurrence', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: {
        starts_at: new Date().toISOString(),
        seed_layer: SEED_LAYER_A,
        recurrence: 'not a cron',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_recurrence' });
  });
});

describe('PATCH /api/v1/servers/:id/seed-schedule/:entryId', () => {
  async function createEntry(cookie: string, serverId: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: SEED_LAYER_A },
    });
    return res.json<{ id: string }>().id;
  }

  it('returns 403 for a role without changemap', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const entryId = await createEntry(ownerCookie, serverId);
    const cookie = await asRoleWithSquadPermissions([]);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/seed-schedule/${entryId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it('toggles enabled and updates fields, writing audit', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const entryId = await createEntry(cookie, serverId);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/seed-schedule/${entryId}`,
      headers: { cookie },
      payload: { enabled: false, seed_layer: SEED_LAYER_B },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ enabled: boolean; seed_layer: string }>();
    expect(body.enabled).toBe(false);
    expect(body.seed_layer).toBe(SEED_LAYER_B);

    await assertAuditRow(h, {
      action: 'server.seed_schedule.update',
      resource: 'seed_schedule',
      targetId: entryId,
    });
  });

  it('returns 404 for an unknown entry id', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/seed-schedule/019f46a1-0000-7000-8000-000000000000`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/servers/:id/seed-schedule/:entryId', () => {
  it('returns 403 for a role without changemap', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const createRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie: ownerCookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: SEED_LAYER_A },
    });
    const entryId = createRes.json<{ id: string }>().id;
    const cookie = await asRoleWithSquadPermissions([]);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/seed-schedule/${entryId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('deletes the entry and writes audit', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const createRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
      payload: { starts_at: new Date().toISOString(), seed_layer: SEED_LAYER_A },
    });
    const entryId = createRes.json<{ id: string }>().id;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/seed-schedule/${entryId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, id: entryId });

    const listRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule`,
      headers: { cookie },
    });
    expect(listRes.json<{ entries: { id: string }[] }>().entries).toEqual([]);

    await assertAuditRow(h, {
      action: 'server.seed_schedule.delete',
      resource: 'seed_schedule',
      targetId: entryId,
    });
  });
});

describe('GET /api/v1/servers/:id/seed-schedule/history', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule/history`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('pairs started/ended seeding events into closed windows and leaves an unmatched start open', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);

    const startedAt1 = new Date('2026-07-01T08:00:00.000Z');
    const endedAt1 = new Date('2026-07-01T08:30:00.000Z');
    const startedAt2 = new Date('2026-07-02T08:00:00.000Z'); // never ended (open window)

    await h.db.insert(events).values([
      {
        eventId: uuidv7(),
        serverId,
        occurredAt: startedAt1,
        kind: 'server.seeding_started',
        payload: { player_count: 3, layer: SEED_LAYER_A },
      },
      {
        eventId: uuidv7(),
        serverId,
        occurredAt: endedAt1,
        kind: 'server.seeding_ended',
        payload: { player_count: 62, layer: SEED_LAYER_A },
      },
      {
        eventId: uuidv7(),
        serverId,
        occurredAt: startedAt2,
        kind: 'server.seeding_started',
        payload: { player_count: 2, layer: SEED_LAYER_B },
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/seed-schedule/history?from=2026-07-01T00:00:00.000Z&to=2026-07-03T00:00:00.000Z`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      windows: { started_at: string; ended_at: string | null; layer: string | null }[];
    }>();
    expect(body.windows).toEqual([
      {
        started_at: startedAt1.toISOString(),
        ended_at: endedAt1.toISOString(),
        layer: SEED_LAYER_A,
        player_count_at_start: 3,
      },
      {
        started_at: startedAt2.toISOString(),
        ended_at: null,
        layer: SEED_LAYER_B,
        player_count_at_start: 2,
      },
    ]);
  });
});
