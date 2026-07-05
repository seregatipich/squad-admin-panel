import { gameVoteBallots, gameVotes, players, roles, servers } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
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

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(830001);
const NO_PANEL_STEAM = testSteamId(830002);

const SERVER_A = '019e0000-0000-7000-8000-00000000aa01';
const SERVER_B = '019e0000-0000-7000-8000-00000000bb02';

const WINDOW_FROM = '2026-06-01T00:00:00.000Z';
const WINDOW_TO = '2026-06-02T00:00:00.000Z';

let h: IntegrationHarness;
let ownerCookie: string;

let skipper: string;
let alfa: string;
let bravo: string;
let charlie: string;
let recentSkipper: string;
let nearMiss: string;

interface VoteSeed {
  serverId: string;
  startedAt: string;
  initiatorPlayerId: string | null;
  voteType: 'map_skip' | 'map_change' | 'admin';
  result: 'passed' | 'failed' | 'cancelled' | null;
  mapCurrent?: string | null;
}

async function seedPlayer(steamSuffix: number, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      id: uuidv7(),
      steamId64: testSteamId(steamSuffix),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedVote(seed: VoteSeed): Promise<string> {
  const id = uuidv7();
  const startedAt = new Date(seed.startedAt);
  await h.db.insert(gameVotes).values({
    id,
    serverId: seed.serverId,
    initiatorPlayerId: seed.initiatorPlayerId,
    voteType: seed.voteType,
    mapCurrent: seed.mapCurrent ?? null,
    votesCollected: 12,
    votesRequired: 20,
    result: seed.result,
    durationSeconds: 45,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 45_000),
  });
  return id;
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
    userAgent: 'vote-analytics-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

function fetchVotes(query: string, cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/analytics/votes${query}`,
    headers: { cookie },
  });
}

interface VotePayload {
  server_id: string | null;
  summary: {
    total_votes: number;
    passed: number;
    failed: number;
    cancelled: number;
    pass_rate: number;
  };
  pass_rate_by_server: Array<{
    server_id: string;
    server_name: string | null;
    total: number;
    passed: number;
    pass_rate: number;
  }>;
  pass_rate_by_map: Array<{ map: string; total: number; passed: number; pass_rate: number }>;
  trend: Array<{ day: string; count: number }>;
  top_initiators: Array<{
    player_id: string;
    nickname: string | null;
    initiated: number;
    passed: number;
    success_ratio: number;
  }>;
  by_hour: Array<{ hour: number; count: number }>;
  serial_skippers: Array<{ player_id: string; nickname: string | null; skip_count: number }>;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'VoteAnalyticsOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    id: uuidv7(),
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'VoteAnalyticsNoPanel',
    canonicalNameNormalized: 'voteanalyticsnopanel',
    roleId: queuePriority[0]?.id ?? null,
  });

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Server A', slug: 'vote-server-a' },
    { id: SERVER_B, displayName: 'Server B', slug: 'vote-server-b' },
  ]);

  skipper = await seedPlayer(830010, 'Skipper');
  alfa = await seedPlayer(830011, 'Alfa');
  bravo = await seedPlayer(830012, 'Bravo');
  charlie = await seedPlayer(830013, 'Charlie');
  recentSkipper = await seedPlayer(830014, 'RecentSkipper');
  nearMiss = await seedPlayer(830015, 'NearMiss');

  const inWindow: VoteSeed[] = [
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T08:00:00.000Z',
      initiatorPlayerId: skipper,
      voteType: 'map_skip',
      result: 'passed',
      mapCurrent: 'Narva',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T09:00:00.000Z',
      initiatorPlayerId: skipper,
      voteType: 'map_skip',
      result: 'failed',
      mapCurrent: 'Narva',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T10:00:00.000Z',
      initiatorPlayerId: skipper,
      voteType: 'map_skip',
      result: 'passed',
      mapCurrent: 'Gorodok',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T11:00:00.000Z',
      initiatorPlayerId: skipper,
      voteType: 'map_skip',
      result: 'cancelled',
      mapCurrent: 'Narva',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T12:00:00.000Z',
      initiatorPlayerId: skipper,
      voteType: 'map_skip',
      result: 'passed',
      mapCurrent: 'Gorodok',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T13:00:00.000Z',
      initiatorPlayerId: alfa,
      voteType: 'map_change',
      result: 'passed',
      mapCurrent: 'Gorodok',
    },
    {
      serverId: SERVER_A,
      startedAt: '2026-06-01T14:00:00.000Z',
      initiatorPlayerId: bravo,
      voteType: 'admin',
      result: 'passed',
      mapCurrent: null,
    },
    {
      serverId: SERVER_B,
      startedAt: '2026-06-01T08:00:00.000Z',
      initiatorPlayerId: alfa,
      voteType: 'map_skip',
      result: 'failed',
      mapCurrent: 'Yehorivka',
    },
    {
      serverId: SERVER_B,
      startedAt: '2026-06-01T15:00:00.000Z',
      initiatorPlayerId: charlie,
      voteType: 'map_skip',
      result: 'passed',
      mapCurrent: 'Yehorivka',
    },
  ];
  for (const seed of inWindow) await seedVote(seed);

  await seedVote({
    serverId: SERVER_A,
    startedAt: '2026-06-05T08:00:00.000Z',
    initiatorPlayerId: skipper,
    voteType: 'map_skip',
    result: 'passed',
    mapCurrent: 'Narva',
  });

  const hourMs = 3_600_000;
  const base = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < 5; i += 1) {
    const id = await seedVote({
      serverId: SERVER_A,
      startedAt: new Date(base + i * hourMs).toISOString(),
      initiatorPlayerId: recentSkipper,
      voteType: 'map_skip',
      result: i % 2 === 0 ? 'passed' : 'failed',
      mapCurrent: 'Mutaha',
    });
    if (i < 3) {
      await h.db.insert(gameVoteBallots).values({
        voteId: id,
        playerId: recentSkipper,
        choice: 'yes',
        votedAt: new Date(base + i * hourMs),
      });
    }
  }
  for (let i = 0; i < 4; i += 1) {
    await seedVote({
      serverId: SERVER_B,
      startedAt: new Date(base + i * hourMs).toISOString(),
      initiatorPlayerId: nearMiss,
      voteType: 'map_skip',
      result: 'passed',
      mapCurrent: 'Fallujah',
    });
  }
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/analytics/votes', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/analytics/votes' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a role without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('summarizes pass rate over the window matching a control query', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as VotePayload;

    expect(body.summary).toEqual({
      total_votes: 9,
      passed: 6,
      failed: 2,
      cancelled: 1,
      pass_rate: 66.7,
    });

    const control = (await h.db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE result = 'passed')::int AS passed
      FROM ${gameVotes}
      WHERE started_at >= ${WINDOW_FROM}::timestamptz AND started_at < ${WINDOW_TO}::timestamptz
    `)) as unknown as Array<{ total: number; passed: number }>;
    expect(Number(control[0]?.total)).toBe(body.summary.total_votes);
    expect(Number(control[0]?.passed)).toBe(body.summary.passed);
  });

  it('computes pass rate per server and per map', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as VotePayload;

    const byServer = new Map(body.pass_rate_by_server.map((r) => [r.server_id, r]));
    expect(byServer.get(SERVER_A)).toMatchObject({ total: 7, passed: 5, pass_rate: 71.4 });
    expect(byServer.get(SERVER_B)).toMatchObject({ total: 2, passed: 1, pass_rate: 50 });

    expect(body.pass_rate_by_map).toEqual([
      { map: 'Narva', total: 3, passed: 1, pass_rate: 33.3 },
      { map: 'Gorodok', total: 2, passed: 2, pass_rate: 100 },
      { map: 'Yehorivka', total: 2, passed: 1, pass_rate: 50 },
    ]);
  });

  it('returns votes trend and hour-of-day distribution', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as VotePayload;

    expect(body.trend).toEqual([{ day: '2026-06-01', count: 9 }]);

    expect(body.by_hour).toHaveLength(24);
    const byHour = new Map(body.by_hour.map((r) => [r.hour, r.count]));
    expect(byHour.get(8)).toBe(2);
    expect(byHour.get(9)).toBe(1);
    expect(byHour.get(15)).toBe(1);
    expect(byHour.get(0)).toBe(0);
  });

  it('ranks top initiators with success ratio', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as VotePayload;

    expect(body.top_initiators[0]).toMatchObject({
      player_id: skipper,
      initiated: 5,
      passed: 3,
      success_ratio: 60,
    });
    const alfaRow = body.top_initiators.find((r) => r.player_id === alfa);
    expect(alfaRow).toMatchObject({ initiated: 2, passed: 1, success_ratio: 50 });
  });

  it('flags serial skippers at the threshold', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as VotePayload;
    expect(body.serial_skippers).toEqual([
      { player_id: skipper, nickname: 'Skipper', skip_count: 5 },
    ]);
  });

  it('filters every metric by server_id', async () => {
    const res = await fetchVotes(`?server_id=${SERVER_B}&from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const body = res.json() as VotePayload;
    expect(body.server_id).toBe(SERVER_B);
    expect(body.summary.total_votes).toBe(2);
    expect(body.pass_rate_by_server.map((r) => r.server_id)).toEqual([SERVER_B]);
    expect(body.pass_rate_by_map).toEqual([
      { map: 'Yehorivka', total: 2, passed: 1, pass_rate: 50 },
    ]);
    expect(body.serial_skippers).toEqual([]);
  });

  it('excludes votes outside the requested window', async () => {
    const res = await fetchVotes(
      `?server_id=${SERVER_A}&from=2026-06-04T00:00:00.000Z&to=2026-06-06T00:00:00.000Z`,
    );
    const body = res.json() as VotePayload;
    expect(body.summary.total_votes).toBe(1);
    expect(body.trend).toEqual([{ day: '2026-06-05', count: 1 }]);
  });

  it('exports CSV with a stable long-format shape', async () => {
    const res = await fetchVotes(`?from=${WINDOW_FROM}&to=${WINDOW_TO}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('vote-analytics.csv');

    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('section,key,value');
    expect(rows).toContain('summary,total_votes,9');
    expect(rows).toContain('summary,pass_rate,66.7');
    expect(rows).toContain('trend,2026-06-01,9');
    expect(rows).toContain('serial_skipper,Skipper,5');
  });
});

describeIfDb('GET /api/v1/players/:playerId/vote-stats', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${recentSkipper}/vote-stats`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns initiated/participated counters and a serial-skipper flag at threshold', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${recentSkipper}/vote-stats`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      player_id: recentSkipper,
      initiated: 5,
      participated: 3,
      serial_skipper: { flagged: true, skip_count: 5, threshold: 5, window_days: 7 },
    });
  });

  it('does not flag a player below the threshold', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${nearMiss}/vote-stats`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as {
      initiated: number;
      serial_skipper: { flagged: boolean; skip_count: number };
    };
    expect(body.initiated).toBe(4);
    expect(body.serial_skipper.flagged).toBe(false);
    expect(body.serial_skipper.skip_count).toBe(4);
  });
});
