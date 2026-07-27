import { playerSessions, players, roles, serverDailyStats, servers } from '@squad/db/schema';
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

const OWNER_STEAM = testSteamId(980001);
const NO_PANEL_STEAM = testSteamId(980002);

const SERVER_A = '019e0000-0000-7000-8000-0000000980a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000980b2';

const FROM = '2026-06-01T00:00:00.000Z';
const TO = '2026-06-03T00:00:00.000Z';

let h: IntegrationHarness;
let ownerCookie: string;
let playerA: string;

interface SeriesPoint {
  key: string;
  value: number;
}
interface Series {
  by_server: Array<{ server_id: string; points: SeriesPoint[] }>;
  totals: SeriesPoint[];
  kpi: { avg: number; max: number; total: number };
}
interface StatisticsBody {
  from: string;
  to: string;
  days: string[];
  servers: Array<{ server_id: string; display_name: string }>;
  population: {
    avg_online: Series;
    peak_online: Series;
    avg_queue: Series;
    by_hour: Series;
    by_weekday: Series;
  };
  matches: {
    by_day: Series;
    modes: Array<{ mode: string; matches: number }>;
    maps: Array<{ map: string; matches: number }>;
  };
  community: { new_players: Series; chat_messages: Series; teamkills: Series };
  moderation: { punishments: Series; avg_admins: Series; peak_admins: Series };
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
    userAgent: 'statistics-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

function fetchStatistics(query: string, cookie = ownerCookie) {
  return h.app.inject({ method: 'GET', url: `/api/v1/statistics${query}`, headers: { cookie } });
}

function seriesFor(series: Series, serverId: string): SeriesPoint[] {
  const entry = series.by_server.find((s) => s.server_id === serverId);
  if (!entry) throw new Error(`no series for server ${serverId}`);
  return entry.points;
}

function valueAt(series: Series, serverId: string, key: string): number {
  const point = seriesFor(series, serverId).find((p) => p.key === key);
  if (!point) throw new Error(`no point ${key} for server ${serverId}`);
  return point.value;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'StatisticsOwner' },
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
    canonicalName: 'StatisticsNoPanel',
    canonicalNameNormalized: 'statisticsnopanel',
    roleId: queuePriority[0]?.id ?? null,
  });

  const [seeded] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(980010),
      canonicalName: 'StatisticsPlayerA',
      canonicalNameNormalized: 'statisticsplayera',
    })
    .returning({ id: players.id });
  if (!seeded) throw new Error('failed to seed statistics player');
  playerA = seeded.id;

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Stats Server A', slug: 'stats-server-a' },
    { id: SERVER_B, displayName: 'Stats Server B', slug: 'stats-server-b' },
  ]);

  await h.db.insert(serverDailyStats).values([
    {
      serverId: SERVER_A,
      day: '2026-06-01',
      avgOnline: 10,
      peakOnline: 40,
      avgQueue: 2,
      onlineSeconds: 864_000,
      matches: 5,
      modes: { AAS: 3, RAAS: 1, Seed: 1 },
      maps: { Narva: 3, Gorodok: 1 },
      newPlayers: 4,
      chatMessages: 120,
      teamkills: 3,
      punishments: 2,
      avgAdmins: 1,
      peakAdmins: 3,
    },
    {
      serverId: SERVER_A,
      day: '2026-06-02',
      avgOnline: 20,
      peakOnline: 60,
      avgQueue: 5,
      onlineSeconds: 1_728_000,
      matches: 7,
      modes: { AAS: 5, RAAS: 2 },
      maps: { Narva: 4, Yehorivka: 3 },
      newPlayers: 6,
      chatMessages: 200,
      teamkills: 1,
      punishments: 4,
      avgAdmins: 2,
      peakAdmins: 5,
    },
    {
      serverId: SERVER_B,
      day: '2026-06-01',
      avgOnline: 3,
      peakOnline: 12,
      avgQueue: 0,
      onlineSeconds: 259_200,
      matches: 2,
      modes: { RAAS: 2 },
      maps: { Gorodok: 2 },
      newPlayers: 1,
      chatMessages: 30,
      teamkills: 0,
      punishments: 1,
      avgAdmins: 0,
      peakAdmins: 1,
    },
    // Outside the requested window — must never leak into the response.
    {
      serverId: SERVER_A,
      day: '2026-05-20',
      avgOnline: 999,
      peakOnline: 999,
      matches: 999,
      modes: { Insurgency: 999 },
      maps: { Fallujah: 999 },
      chatMessages: 999,
      teamkills: 999,
      punishments: 999,
    },
  ]);

  // Hour-of-day buckets are computed live from sessions: 04:00–06:00 UTC on 2026-06-01.
  await h.db.insert(playerSessions).values([
    {
      playerId: playerA,
      serverId: SERVER_A,
      connectedAt: new Date('2026-06-01T04:00:00Z'),
      disconnectedAt: new Date('2026-06-01T06:00:00Z'),
    },
  ]);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/statistics', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/statistics' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects a role without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}`, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns a dense day axis covering the whole window', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatisticsBody;
    expect(body.days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('lists the requested servers with their display names', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    const listed = body.servers.filter((s) => s.server_id === SERVER_A || s.server_id === SERVER_B);
    expect(listed).toEqual([
      { server_id: SERVER_A, display_name: 'Stats Server A' },
      { server_id: SERVER_B, display_name: 'Stats Server B' },
    ]);
  });

  it('serves the population block per server from server_daily_stats', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    expect(valueAt(body.population.avg_online, SERVER_A, '2026-06-01')).toBe(10);
    expect(valueAt(body.population.avg_online, SERVER_A, '2026-06-02')).toBe(20);
    expect(valueAt(body.population.avg_online, SERVER_B, '2026-06-01')).toBe(3);
    expect(valueAt(body.population.peak_online, SERVER_A, '2026-06-02')).toBe(60);
    expect(valueAt(body.population.avg_queue, SERVER_A, '2026-06-02')).toBe(5);
  });

  it('zero-fills days with no rollup row', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    expect(valueAt(body.population.avg_online, SERVER_B, '2026-06-02')).toBe(0);
    expect(valueAt(body.matches.by_day, SERVER_A, '2026-06-03')).toBe(0);
  });

  it('keeps sum(stacked bars) equal to KPI.total for every daily series', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    const daily: Series[] = [
      body.population.avg_online,
      body.population.peak_online,
      body.population.avg_queue,
      body.matches.by_day,
      body.community.new_players,
      body.community.chat_messages,
      body.community.teamkills,
      body.moderation.punishments,
      body.moderation.avg_admins,
      body.moderation.peak_admins,
    ];
    for (const series of daily) {
      const stacked = series.by_server.reduce(
        (sum, entry) => sum + entry.points.reduce((inner, p) => inner + p.value, 0),
        0,
      );
      expect(stacked).toBe(series.kpi.total);
    }
    expect(body.matches.by_day.kpi.total).toBe(14);
    expect(body.community.chat_messages.kpi.total).toBe(350);
  });

  it('aggregates match modes and maps across the window', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    expect(body.matches.modes).toEqual([
      { mode: 'AAS', matches: 8 },
      { mode: 'RAAS', matches: 5 },
      { mode: 'Seed', matches: 1 },
    ]);
    expect(body.matches.maps).toEqual([
      { map: 'Narva', matches: 7 },
      { map: 'Gorodok', matches: 3 },
      { map: 'Yehorivka', matches: 3 },
    ]);
  });

  it('regroups the daily rows into ISO weekday buckets', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A}`);
    const body = res.json() as StatisticsBody;
    // 2026-06-01 is a Monday, 2026-06-02 a Tuesday.
    expect(valueAt(body.population.by_weekday, SERVER_A, '1')).toBe(10);
    expect(valueAt(body.population.by_weekday, SERVER_A, '2')).toBe(20);
    expect(valueAt(body.population.by_weekday, SERVER_A, '3')).toBe(0);
    expect(body.population.by_weekday.totals).toHaveLength(7);
  });

  it('computes the hour-of-day buckets live from sessions', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A}`);
    const body = res.json() as StatisticsBody;
    expect(body.population.by_hour.totals).toHaveLength(24);
    // One player online for the whole 04:00 and 05:00 hours of one of three days → 1/3.
    expect(valueAt(body.population.by_hour, SERVER_A, '04')).toBeCloseTo(0.3, 1);
    expect(valueAt(body.population.by_hour, SERVER_A, '05')).toBeCloseTo(0.3, 1);
    expect(valueAt(body.population.by_hour, SERVER_A, '12')).toBe(0);
  });

  it('scopes every block to the selected servers', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    expect(body.servers.map((s) => s.server_id)).toEqual([SERVER_B]);
    expect(body.matches.by_day.kpi.total).toBe(2);
    expect(body.matches.modes).toEqual([{ mode: 'RAAS', matches: 2 }]);
  });

  it('excludes rollup rows outside the requested window', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A}`);
    const body = res.json() as StatisticsBody;
    expect(body.matches.modes.some((m) => m.mode === 'Insurgency')).toBe(false);
    expect(body.matches.maps.some((m) => m.map === 'Fallujah')).toBe(false);
    expect(body.population.avg_online.kpi.max).toBe(20);
  });

  it('returns numbers, never strings, for every metric value', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A},${SERVER_B}`);
    const body = res.json() as StatisticsBody;
    for (const series of [
      body.population.avg_online,
      body.population.by_hour,
      body.moderation.peak_admins,
    ]) {
      for (const entry of series.by_server) {
        for (const point of entry.points) expect(typeof point.value).toBe('number');
      }
      for (const point of series.totals) expect(typeof point.value).toBe('number');
      expect(typeof series.kpi.avg).toBe('number');
      expect(typeof series.kpi.max).toBe('number');
      expect(typeof series.kpi.total).toBe('number');
    }
    expect(typeof body.matches.modes[0]?.matches).toBe('number');
    expect(typeof body.matches.maps[0]?.matches).toBe('number');
  });

  it('carries no profiling fields', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A}`);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'community',
      'days',
      'from',
      'matches',
      'moderation',
      'population',
      'servers',
      'to',
    ]);
  });

  it('silently clamps an inverted window instead of erroring', async () => {
    const res = await fetchStatistics(`?from=${TO}&to=${FROM}&servers=${SERVER_A}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatisticsBody;
    expect(body.days.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores unknown server ids in the filter', async () => {
    const res = await fetchStatistics(
      `?from=${FROM}&to=${TO}&servers=${SERVER_A},019e0000-0000-7000-8000-00000000dead`,
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as StatisticsBody).servers.map((s) => s.server_id)).toEqual([SERVER_A]);
  });

  it('exports CSV with the documented long-format shape', async () => {
    const res = await fetchStatistics(`?from=${FROM}&to=${TO}&servers=${SERVER_A}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('statistics.csv');

    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('section,metric,server_id,key,value');
    expect(rows).toContain(`population,avg_online,${SERVER_A},2026-06-01,10`);
    expect(rows).toContain(`matches,by_day,${SERVER_A},2026-06-02,7`);
    expect(rows).toContain('matches,mode,,AAS,8');
    expect(rows).toContain('kpi,chat_messages,,total,320');
  });
});
