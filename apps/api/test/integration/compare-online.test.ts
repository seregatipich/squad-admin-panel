import { playerSessions, players, roles, servers } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(820001);
const PLAYER_A_STEAM = testSteamId(820002);
const PLAYER_B_STEAM = testSteamId(820003);
const NO_ACCESS_STEAM = testSteamId(820004);

let h: IntegrationHarness;
let serverId: string;

async function seedPlayer(
  steamId64: bigint,
  name: string,
  opts: { roleId?: string } = {},
): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId: opts.roleId ?? null,
    })
    .returning({ id: players.id });
  return row.id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'compare-online-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface CompareOnlineResponse {
  window: { from: string; to: string };
  players: Array<{ id: string; canonical_name: string; steam_id64: string | null }>;
  sessions: {
    a: Array<{
      id: string;
      server_id: string;
      mode: string;
      connected_at: string;
      disconnected_at: string | null;
    }>;
    b: Array<{
      id: string;
      server_id: string;
      mode: string;
      connected_at: string;
      disconnected_at: string | null;
    }>;
  };
  overlap: {
    total_seconds: number;
    concurrent_count: number;
    intervals: Array<{ from: string; to: string }>;
  };
}

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'CompareOnline server',
    slug: `compare-online-${serverId}`,
  });
});

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('GET /api/v1/players/:playerId/compare-online', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/compare-online?other=${uuidv7()}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects a logged-in player without panel_access with 403', async () => {
    const roleId = uuidv7();
    await h.db
      .insert(roles)
      .values({ id: roleId, name: 'NoAccessRole', color: '#333333', panelAccess: false });
    await seedPlayer(NO_ACCESS_STEAM, 'NoAccess', { roleId });
    const cookie = await loginAsSteam(NO_ACCESS_STEAM);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/compare-online?other=${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns 404 when the target player does not exist', async () => {
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${uuidv7()}/compare-online?other=${idB}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'player_not_found' });
  });

  it('returns 404 when the "other" player does not exist', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${uuidv7()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'player_not_found' });
  });

  it('rejects comparing a player against itself with 422 same_player', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idA}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'same_player' });
  });

  it('rejects from > to with 422 invalid_window', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}&from=2026-07-10&to=2026-07-01`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'invalid_window' });
  });

  it('accepts an exactly-31-day window', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}&from=2026-06-01&to=2026-07-01`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a 32-day window with 422 window_too_large', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}&from=2026-06-01&to=2026-07-02`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'window_too_large' });
  });

  it('defaults to a trailing 7-day window when from/to are omitted', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareOnlineResponse;
    const today = new Date().toISOString().slice(0, 10);
    expect(body.window.to).toBe(today);
    const fromMs = Date.parse(`${body.window.from}T00:00:00.000Z`);
    const toMs = Date.parse(`${body.window.to}T00:00:00.000Z`);
    expect((toMs - fromMs) / 86_400_000).toBe(6);
  });

  it('computes a hand-checked overlap for two players with an overlapping session (AC)', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');

    await h.db.insert(playerSessions).values([
      {
        playerId: idA,
        serverId,
        mode: 'online',
        connectedAt: new Date('2026-07-03T10:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T12:00:00.000Z'),
        durationSeconds: 7200,
      },
      {
        playerId: idB,
        serverId,
        mode: 'online',
        connectedAt: new Date('2026-07-03T11:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T13:00:00.000Z'),
        durationSeconds: 7200,
      },
      // Non-overlapping session for A on a different day — must not contribute.
      {
        playerId: idA,
        serverId,
        mode: 'online',
        connectedAt: new Date('2026-07-04T08:00:00.000Z'),
        disconnectedAt: new Date('2026-07-04T09:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}&from=2026-07-01&to=2026-07-07`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareOnlineResponse;

    expect(body.players.map((p) => p.id)).toEqual([idA, idB]);
    expect(body.players[0].canonical_name).toBe('PlayerA');
    expect(body.players[1].canonical_name).toBe('PlayerB');

    expect(body.sessions.a).toHaveLength(2);
    expect(body.sessions.b).toHaveLength(1);

    expect(body.overlap.total_seconds).toBe(3600);
    expect(body.overlap.concurrent_count).toBe(1);
    expect(body.overlap.intervals).toEqual([
      { from: '2026-07-03T11:00:00.000Z', to: '2026-07-03T12:00:00.000Z' },
    ]);
  });

  it('clamps an open session for the "other" player to now and includes it in the overlap', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 7_200_000);
    const oneHourAgo = new Date(now.getTime() - 3_600_000);

    await h.db.insert(playerSessions).values([
      { playerId: idA, serverId, mode: 'online', connectedAt: twoHoursAgo, disconnectedAt: null },
      { playerId: idB, serverId, mode: 'online', connectedAt: oneHourAgo, disconnectedAt: null },
    ]);

    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareOnlineResponse;

    expect(body.sessions.a[0]?.disconnected_at).toBeNull();
    expect(body.sessions.b[0]?.disconnected_at).toBeNull();
    // Both open sessions clamp to "now" and overlap for at least the last hour.
    expect(body.overlap.total_seconds).toBeGreaterThanOrEqual(3595);
    expect(body.overlap.concurrent_count).toBe(1);
  });

  it('never leaks IP data in the response payload (regression)', async () => {
    const idA = await seedPlayer(PLAYER_A_STEAM, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B_STEAM, 'PlayerB');
    await h.db.insert(playerSessions).values([
      {
        playerId: idA,
        serverId,
        mode: 'online',
        connectedAt: new Date('2026-07-03T10:00:00.000Z'),
        disconnectedAt: new Date('2026-07-03T11:00:00.000Z'),
        durationSeconds: 3600,
      },
    ]);
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/compare-online?other=${idB}&from=2026-07-01&to=2026-07-07`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.payload;
    expect(raw.toLowerCase()).not.toContain('"ip"');
    expect(raw.toLowerCase()).not.toContain('ip_history');
  });
});
