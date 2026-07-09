import {
  clanMembers,
  clans,
  playerDailyPresence,
  playerSessions,
  playerStatPeriods,
  players,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(873001);
const NO_PANEL_STEAM = testSteamId(873099);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let clanId: string;
let emptyClanId: string;
let serverAId: string;
let serverBId: string;
let memberOne: string;
let memberTwo: string;
let memberThree: string;
let stranger: string;

const WINDOW_FROM = '2026-06-01';
const WINDOW_TO = '2026-06-07';
const BEFORE_WINDOW = '2026-05-25';

async function seedPlayer(name: string, steamSeed: number): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSeed),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedServer(name: string): Promise<string> {
  const id = uuidv7();
  await h.db.insert(servers).values({
    id,
    displayName: name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id}`,
  });
  return id;
}

async function seedPresence(opts: {
  playerId: string;
  serverId: string;
  day: string;
  online: number;
  boost?: number;
}): Promise<void> {
  await h.db.insert(playerDailyPresence).values({
    playerId: opts.playerId,
    serverId: opts.serverId,
    day: opts.day,
    onlineSeconds: opts.online,
    boostSeconds: opts.boost ?? 0,
  });
}

async function seedStatPeriod(opts: {
  playerId: string;
  serverId: string | null;
  periodStart: string;
  kills: number;
  deaths: number;
  revives?: number;
}): Promise<void> {
  await h.db.insert(playerStatPeriods).values({
    playerId: opts.playerId,
    serverId: opts.serverId,
    periodType: 'day',
    periodStart: opts.periodStart,
    kills: opts.kills,
    deaths: opts.deaths,
    revives: opts.revives ?? 0,
  });
}

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
    userAgent: 'clans-stats-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });

  serverAId = await seedServer('Статистика А');
  serverBId = await seedServer('Статистика Б');

  memberOne = await seedPlayer('Статист 1', 873002);
  memberTwo = await seedPlayer('Статист 2', 873003);
  memberThree = await seedPlayer('Статист 3', 873004);
  stranger = await seedPlayer('Статист Чужой', 873005);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'Статист Без доступа',
    canonicalNameNormalized: 'статист без доступа',
  });

  clanId = uuidv7();
  await h.db.insert(clans).values({ id: clanId, name: 'Клан статистики', tags: ['STC'] });
  await h.db.insert(clanMembers).values([
    { clanId, playerId: memberOne, memberRole: 'leader', hasPriority: true },
    { clanId, playerId: memberTwo, memberRole: 'deputy', hasPriority: false },
    { clanId, playerId: memberThree, memberRole: 'member', hasPriority: false },
  ]);

  emptyClanId = uuidv7();
  await h.db.insert(clans).values({ id: emptyClanId, name: 'Клан без данных', tags: ['EMP'] });
  await h.db
    .insert(clanMembers)
    .values([
      { clanId: emptyClanId, playerId: stranger, memberRole: 'leader', hasPriority: false },
    ]);

  // Presence within the window, spread across two servers and two members.
  await seedPresence({
    playerId: memberOne,
    serverId: serverAId,
    day: WINDOW_FROM,
    online: 1000,
    boost: 100,
  });
  await seedPresence({
    playerId: memberOne,
    serverId: serverAId,
    day: '2026-06-02',
    online: 2000,
    boost: 50,
  });
  await seedPresence({
    playerId: memberTwo,
    serverId: serverBId,
    day: WINDOW_FROM,
    online: 500,
  });
  await seedPresence({
    playerId: memberThree,
    serverId: serverAId,
    day: '2026-06-03',
    online: 300,
  });
  // Outside the requested window — must not affect totals/chart.
  await seedPresence({
    playerId: memberOne,
    serverId: serverAId,
    day: BEFORE_WINDOW,
    online: 9999,
  });
  // Stranger presence must not leak into the clan's roster-scoped totals.
  await seedPresence({
    playerId: stranger,
    serverId: serverAId,
    day: WINDOW_FROM,
    online: 7777,
  });

  // Combat: only server_id IS NULL rollup rows should be summed (avoids double counting
  // the per-server breakdown rows that recomputeLeaderboardPeriod also writes).
  await seedStatPeriod({
    playerId: memberOne,
    serverId: null,
    periodStart: WINDOW_FROM,
    kills: 10,
    deaths: 2,
    revives: 1,
  });
  await seedStatPeriod({
    playerId: memberOne,
    serverId: null,
    periodStart: '2026-06-02',
    kills: 5,
    deaths: 3,
  });
  await seedStatPeriod({
    playerId: memberOne,
    serverId: serverAId,
    periodStart: WINDOW_FROM,
    kills: 100,
    deaths: 100,
  });
  await seedStatPeriod({
    playerId: memberTwo,
    serverId: null,
    periodStart: WINDOW_FROM,
    kills: 8,
    deaths: 4,
    revives: 2,
  });
  // Outside the window — must not affect totals.
  await seedStatPeriod({
    playerId: memberOne,
    serverId: null,
    periodStart: BEFORE_WINDOW,
    kills: 999,
    deaths: 1,
  });
  // Stranger stats must not leak into the clan's roster-scoped combat totals.
  await seedStatPeriod({
    playerId: stranger,
    serverId: null,
    periodStart: WINDOW_FROM,
    kills: 500,
    deaths: 1,
  });

  await h.db.insert(playerSessions).values({
    playerId: memberOne,
    serverId: serverAId,
    connectedAt: new Date('2026-06-01T14:00:00.000Z'),
    disconnectedAt: new Date('2026-06-01T16:00:00.000Z'),
    mode: 'online',
  });
}, 60_000);

afterAll(async () => {
  await h.cleanup();
}, 60_000);

interface ClanStatsChartPoint {
  day: string;
  online_seconds: number;
  boost_seconds: number;
}
interface ClanStatsServerTotal {
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  online_seconds: number;
}
interface ClanStatsCombatMember {
  player_id: string;
  canonical_name: string;
  kills: number;
  deaths: number;
  revives: number;
  kd: number;
}
interface ClanStatsResponse {
  clan_id: string;
  from: string;
  to: string;
  roster_size: number;
  chart: ClanStatsChartPoint[];
  totals: {
    online_seconds: number;
    boost_seconds: number;
    primary_server: ClanStatsServerTotal | null;
  };
  primetime: {
    total_seconds: number;
    histogram: number[];
    rolling_average: number[];
    range: unknown;
  };
  combat: {
    kills: number;
    deaths: number;
    revives: number;
    kd: number;
    top: ClanStatsCombatMember[];
  };
}

describeIfDb('GET /api/v1/clans/:id/stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/clans/${clanId}/stats` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects users without panel access with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats`,
      headers: { cookie: await loginAsSteam(NO_PANEL_STEAM) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown clan id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${uuidv7()}/stats`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a soft-deleted clan', async () => {
    const deletedId = uuidv7();
    await h.db
      .insert(clans)
      .values({ id: deletedId, name: 'Удалён статистика', deletedAt: new Date() });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${deletedId}/stats`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an inverted date range with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats?from=${WINDOW_TO}&to=${WINDOW_FROM}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('defaults to a trailing 30-day window when from/to are omitted', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ClanStatsResponse;
    const fromMs = Date.parse(`${body.from}T00:00:00.000Z`);
    const toMs = Date.parse(`${body.to}T00:00:00.000Z`);
    expect((toMs - fromMs) / 86_400_000).toBe(29);
  });

  it('aggregates chart/totals/primary_server/combat scoped to the roster and date range', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ClanStatsResponse;

    expect(body.clan_id).toBe(clanId);
    expect(body.from).toBe(WINDOW_FROM);
    expect(body.to).toBe(WINDOW_TO);
    expect(body.roster_size).toBe(3);

    // 7 days inclusive from 2026-06-01 to 2026-06-07.
    expect(body.chart).toHaveLength(7);
    const chartOnlineSum = body.chart.reduce((sum, point) => sum + point.online_seconds, 0);
    expect(chartOnlineSum).toBe(body.totals.online_seconds);
    expect(body.totals.online_seconds).toBe(1000 + 2000 + 500 + 300);
    expect(body.totals.boost_seconds).toBe(100 + 50);

    const day1 = body.chart.find((point) => point.day === WINDOW_FROM);
    expect(day1?.online_seconds).toBe(1000 + 500);
    expect(day1?.boost_seconds).toBe(100);
    const day2 = body.chart.find((point) => point.day === '2026-06-02');
    expect(day2?.online_seconds).toBe(2000);

    expect(body.totals.primary_server?.server_id).toBe(serverAId);
    expect(body.totals.primary_server?.online_seconds).toBe(1000 + 2000 + 300);

    expect(body.combat.kills).toBe(10 + 5 + 8);
    expect(body.combat.deaths).toBe(2 + 3 + 4);
    expect(body.combat.revives).toBe(1 + 2);
    expect(body.combat.kd).toBeCloseTo((10 + 5 + 8) / (2 + 3 + 4), 6);

    expect(body.combat.top.map((member) => member.player_id)).toEqual([memberOne, memberTwo]);
    const topOne = body.combat.top[0];
    expect(topOne?.kills).toBe(15);
    expect(topOne?.deaths).toBe(5);
    expect(topOne?.kd).toBeCloseTo(3, 6);
    const topTwo = body.combat.top[1];
    expect(topTwo?.kills).toBe(8);
    expect(topTwo?.deaths).toBe(4);
    expect(topTwo?.kd).toBeCloseTo(2, 6);

    expect(body.primetime.histogram).toHaveLength(24);
    expect(body.primetime.rolling_average).toHaveLength(24);
    const histogramSum = body.primetime.histogram.reduce((sum, seconds) => sum + seconds, 0);
    expect(histogramSum).toBe(body.primetime.total_seconds);
    expect(body.primetime.total_seconds).toBeGreaterThan(0);
  });

  it('returns a gracefully zeroed payload for a clan with no presence/combat data', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${emptyClanId}/stats?from=2026-01-01&to=2026-01-03`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ClanStatsResponse;
    expect(body.chart).toHaveLength(3);
    expect(body.chart.every((point) => point.online_seconds === 0)).toBe(true);
    expect(body.totals).toEqual({ online_seconds: 0, boost_seconds: 0, primary_server: null });
    expect(body.combat).toEqual({ kills: 0, deaths: 0, revives: 0, kd: 0, top: [] });
    expect(body.primetime.total_seconds).toBe(0);
    expect(body.primetime.range).toBeNull();
  });
});

describeIfDb('GET /api/v1/clans/:id/stats/export', () => {
  it('rejects unauthenticated requests with 401 json', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats/export`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns a CSV attachment with the daily chart rows', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/clans/${clanId}/stats/export?from=${WINDOW_FROM}&to=${WINDOW_TO}`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`clan-${clanId}-stats-`);
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('day,online_seconds,boost_seconds');
    expect(lines).toContain(`${WINDOW_FROM},1500,100`);
    expect(lines).toContain('2026-06-02,2000,50');
  });
});
