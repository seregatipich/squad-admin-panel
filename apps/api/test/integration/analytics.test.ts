import {
  matches,
  playerDailyPresence,
  playerSessions,
  players,
  roles,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const NO_PANEL_STEAM = testSteamId(820002);

const SERVER_A = '019e0000-0000-7000-8000-0000000000a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000000b2';

const WINDOW_FROM = '2026-06-01T00:00:00.000Z';
const WINDOW_TO = '2026-06-02T00:00:00.000Z';

let h: IntegrationHarness;
let ownerCookie: string;
let playerA1: string;
let playerA2: string;
let playerB1: string;

interface DashboardBody {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total_matches: number;
    total_online_hours: number;
    unique_players: number;
    avg_match_duration_seconds: number | null;
  };
  peak_by_hour: Array<{ hour: number; peak_players: number }>;
  match_outcomes: {
    team1: number;
    team2: number;
    draw: number;
    unknown: number;
    total: number;
  };
  popular_maps: Array<{ map: string; matches: number }>;
  popular_layers: Array<{ layer: string; matches: number }>;
}

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'analytics-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(steamSuffix: number, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSuffix),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

function fetchDashboard(query: string, cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/analytics/dashboard${query}`,
    headers: { cookie },
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'AnalyticsOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'AnalyticsNoPanel',
    canonicalNameNormalized: 'analyticsnopanel',
    roleId: queuePriority[0]?.id ?? null,
  });

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Server A', slug: 'server-a' },
    { id: SERVER_B, displayName: 'Server B', slug: 'server-b' },
  ]);

  playerA1 = await seedPlayer(820010, 'PlayerA1');
  playerA2 = await seedPlayer(820011, 'PlayerA2');
  playerB1 = await seedPlayer(820012, 'PlayerB1');

  await h.db.insert(matches).values([
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-01T08:00:00Z'),
      durationSeconds: 1800,
    },
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_RAAS_v1',
      winner: 'team2',
      startedAt: new Date('2026-06-01T09:00:00Z'),
      durationSeconds: 2400,
    },
    {
      serverId: SERVER_A,
      map: 'Gorodok',
      layer: 'Gorodok_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-01T10:00:00Z'),
      durationSeconds: 1200,
    },
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'draw',
      startedAt: new Date('2026-06-01T11:00:00Z'),
      durationSeconds: 3000,
    },
    {
      serverId: SERVER_A,
      map: 'Gorodok',
      layer: 'Gorodok_RAAS_v1',
      winner: null,
      startedAt: new Date('2026-06-01T12:00:00Z'),
      durationSeconds: null,
    },
    {
      serverId: SERVER_B,
      map: 'Yehorivka',
      layer: 'Yehorivka_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-01T13:00:00Z'),
      durationSeconds: 900,
    },
    {
      serverId: SERVER_A,
      map: 'Narva',
      layer: 'Narva_AAS_v1',
      winner: 'team1',
      startedAt: new Date('2026-06-05T08:00:00Z'),
      durationSeconds: 1800,
    },
  ]);

  await h.db.insert(playerSessions).values([
    {
      playerId: playerA1,
      serverId: SERVER_A,
      connectedAt: new Date('2026-06-01T09:30:00Z'),
      disconnectedAt: new Date('2026-06-01T11:15:00Z'),
    },
    {
      playerId: playerA2,
      serverId: SERVER_A,
      connectedAt: new Date('2026-06-01T10:00:00Z'),
      disconnectedAt: new Date('2026-06-01T10:50:00Z'),
    },
    {
      playerId: playerB1,
      serverId: SERVER_B,
      connectedAt: new Date('2026-06-01T10:15:00Z'),
      disconnectedAt: new Date('2026-06-01T13:40:00Z'),
    },
  ]);

  await h.db.insert(playerDailyPresence).values([
    { playerId: playerA1, day: '2026-06-01', serverId: SERVER_A, onlineSeconds: 3600 },
    { playerId: playerA2, day: '2026-06-01', serverId: SERVER_A, onlineSeconds: 7200 },
    { playerId: playerB1, day: '2026-06-02', serverId: SERVER_B, onlineSeconds: 1800 },
    { playerId: playerA1, day: '2026-06-05', serverId: SERVER_A, onlineSeconds: 9999 },
  ]);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/analytics/dashboard', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/analytics/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a role without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('aggregates matches, outcomes and popular maps/layers across all servers', async () => {
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardBody;

    expect(body.server_id).toBeNull();
    expect(body.summary.total_matches).toBe(6);
    expect(body.summary.avg_match_duration_seconds).toBe(1860);

    expect(body.match_outcomes).toEqual({ team1: 3, team2: 1, draw: 1, unknown: 1, total: 6 });

    expect(body.popular_maps).toEqual([
      { map: 'Narva', matches: 3 },
      { map: 'Gorodok', matches: 2 },
      { map: 'Yehorivka', matches: 1 },
    ]);

    expect(body.popular_layers[0]).toEqual({ layer: 'Narva_AAS_v1', matches: 2 });
    expect(body.popular_layers.map((l) => l.layer)).toEqual([
      'Narva_AAS_v1',
      'Gorodok_AAS_v1',
      'Gorodok_RAAS_v1',
      'Narva_RAAS_v1',
      'Yehorivka_AAS_v1',
    ]);
  });

  it('returns numeric types (not strings) for aggregates', async () => {
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as DashboardBody;
    expect(typeof body.summary.total_matches).toBe('number');
    expect(typeof body.summary.total_online_hours).toBe('number');
    expect(typeof body.summary.unique_players).toBe('number');
    expect(typeof body.match_outcomes.total).toBe('number');
    expect(typeof body.popular_maps[0]?.matches).toBe('number');
    expect(typeof body.peak_by_hour[0]?.peak_players).toBe('number');
  });

  it('computes peak concurrent players by hour-of-day from sessions', async () => {
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as DashboardBody;
    expect(body.peak_by_hour).toHaveLength(24);
    const byHour = new Map(body.peak_by_hour.map((entry) => [entry.hour, entry.peak_players]));
    expect(byHour.get(10)).toBe(2);
    expect(byHour.get(11)).toBe(2);
    expect(byHour.get(12)).toBe(1);
    expect(byHour.get(13)).toBe(1);
    expect(byHour.get(9)).toBe(0);
    expect(byHour.get(0)).toBe(0);
  });

  it('aggregates online hours and unique players from daily presence', async () => {
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as DashboardBody;
    expect(body.summary.total_online_hours).toBe(3.5);
    expect(body.summary.unique_players).toBe(3);
  });

  it('filters every aggregate by server_id', async () => {
    const res = await fetchDashboard(`?server_id=${SERVER_A}&from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as DashboardBody;
    expect(body.server_id).toBe(SERVER_A);
    expect(body.summary.total_matches).toBe(5);
    expect(body.summary.avg_match_duration_seconds).toBe(2100);
    expect(body.match_outcomes).toEqual({ team1: 2, team2: 1, draw: 1, unknown: 1, total: 5 });
    expect(body.popular_maps).toEqual([
      { map: 'Narva', matches: 3 },
      { map: 'Gorodok', matches: 2 },
    ]);
    expect(body.summary.total_online_hours).toBe(3);

    const byHour = new Map(body.peak_by_hour.map((entry) => [entry.hour, entry.peak_players]));
    expect(byHour.get(10)).toBe(2);
    expect(byHour.get(11)).toBe(1);
    expect(byHour.get(12)).toBe(0);
  });

  it('excludes matches and presence outside the requested window', async () => {
    const res = await fetchDashboard(
      `?server_id=${SERVER_A}&from=2026-06-04T00:00:00.000Z&to=2026-06-06T00:00:00.000Z`,
    );
    const body = res.json() as DashboardBody;
    expect(body.summary.total_matches).toBe(1);
    expect(body.match_outcomes.team1).toBe(1);
    expect(body.summary.unique_players).toBe(1);
    expect(body.summary.total_online_hours).toBeCloseTo(9999 / 3600, 2);
  });

  it('exports CSV with a stable long-format shape', async () => {
    const res = await fetchDashboard(`?from=${WINDOW_FROM}&to=${WINDOW_TO}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('analytics-dashboard.csv');

    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('section,key,value');
    expect(rows).toContain('summary,total_matches,6');
    expect(rows).toContain('match_outcome,team1,3');
    expect(rows).toContain('popular_map,Narva,3');
    expect(rows).toContain('peak_by_hour,10,2');
    expect(rows.filter((r) => r.startsWith('peak_by_hour,'))).toHaveLength(24);
  });
});
