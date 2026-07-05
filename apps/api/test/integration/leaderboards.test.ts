import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerStatPeriods, players, roles, servers } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
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

const OWNER_STEAM = testSteamId(830001);
const NO_PANEL_STEAM = testSteamId(830002);

const SERVER_A = '019e0000-0000-7000-8000-0000000000c1';
const SERVER_B = '019e0000-0000-7000-8000-0000000000c2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAT_PERIODS_SQL = readFileSync(
  path.resolve(__dirname, '../../../../packages/db/sql/player-stat-periods.sql'),
  'utf-8',
);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let alpha: string;
let bravo: string;
let charlie: string;

interface LeaderboardRow {
  rank: number;
  player_id: string;
  current_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  metric_value: number;
  secondary: {
    online_seconds: number;
    seeding_seconds: number;
    kills: number;
    deaths: number;
    kd: number;
    matches_played: number;
  };
}

interface LeaderboardBody {
  metric: string;
  period: string;
  period_start: string;
  server_id: string | null;
  available: boolean;
  total_rows: number;
  total_pages: number;
  rows: LeaderboardRow[];
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
    userAgent: 'leaderboards-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedPlayer(steamSuffix: number, name: string, eosId: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(steamSuffix),
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

function fetchLeaderboard(query: string, cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/leaderboards${query}`,
    headers: { cookie },
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'LeaderboardOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  for (const stmt of STAT_PERIODS_SQL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await h.db.execute(sql.raw(trimmed));
  }

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'LeaderboardNoPanel',
    canonicalNameNormalized: 'leaderboardnopanel',
    roleId: queuePriority[0]?.id ?? null,
  });

  await h.db.insert(servers).values([
    { id: SERVER_A, displayName: 'Server A', slug: 'lb-server-a' },
    { id: SERVER_B, displayName: 'Server B', slug: 'lb-server-b' },
  ]);

  alpha = await seedPlayer(830010, 'Alpha', 'eos-alpha');
  bravo = await seedPlayer(830011, 'Bravo', 'eos-bravo');
  charlie = await seedPlayer(830012, 'Charlie', 'eos-charlie');

  await h.db.insert(playerStatPeriods).values([
    {
      playerId: alpha,
      serverId: SERVER_A,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 5000,
      matchesPlayed: 4,
    },
    {
      playerId: alpha,
      serverId: SERVER_B,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 1000,
      matchesPlayed: 1,
    },
    {
      playerId: bravo,
      serverId: SERVER_A,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 3000,
      matchesPlayed: 2,
    },
    {
      playerId: charlie,
      serverId: SERVER_A,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 7000,
      matchesPlayed: 9,
    },
    {
      playerId: alpha,
      serverId: null,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 6000,
      matchesPlayed: 5,
    },
    {
      playerId: bravo,
      serverId: null,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 3000,
      matchesPlayed: 2,
    },
    {
      playerId: charlie,
      serverId: null,
      periodType: 'alltime',
      periodStart: '1970-01-01',
      onlineSeconds: 7000,
      matchesPlayed: 9,
    },
  ]);
});

afterAll(async () => {
  await h.cleanup();
});

describeIfDb('GET /api/v1/leaderboards', () => {
  it('requires panel_access', async () => {
    const noPanelCookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await fetchLeaderboard('?metric=online', noPanelCookie);
    expect(res.statusCode).toBe(403);
  });

  it('ranks the all-servers rollup by online time', async () => {
    const res = await fetchLeaderboard('?metric=online&period=alltime');
    expect(res.statusCode).toBe(200);
    const body = res.json() as LeaderboardBody;
    expect(body.available).toBe(true);
    expect(body.server_id).toBeNull();
    expect(body.rows.map((r) => r.current_name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(body.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(body.rows[0]?.metric_value).toBe(7000);
    expect(body.rows[1]?.steam_id64).toBe(testSteamId(830010).toString());
    expect(body.rows[1]?.eos_id).toBe('eos-alpha');
    expect(body.total_rows).toBe(3);
  });

  it('filters to a single server', async () => {
    const res = await fetchLeaderboard(`?metric=online&period=alltime&server_id=${SERVER_A}`);
    const body = res.json() as LeaderboardBody;
    expect(body.server_id).toBe(SERVER_A);
    expect(body.rows.map((r) => r.current_name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(body.rows.find((r) => r.current_name === 'Alpha')?.metric_value).toBe(5000);
  });

  it('marks combat metrics unavailable while stats-importer is not ready', async () => {
    const res = await fetchLeaderboard('?metric=kills&period=alltime');
    const body = res.json() as LeaderboardBody;
    expect(body.available).toBe(false);
    expect(body.rows.every((r) => r.metric_value === 0)).toBe(true);
  });

  it('reports matches metric as available', async () => {
    const res = await fetchLeaderboard('?metric=matches&period=alltime');
    const body = res.json() as LeaderboardBody;
    expect(body.available).toBe(true);
    expect(body.rows[0]?.current_name).toBe('Charlie');
    expect(body.rows[0]?.metric_value).toBe(9);
  });

  it('paginates with a global rank and stable tie-break', async () => {
    const first = await fetchLeaderboard('?metric=online&period=alltime&limit=2&offset=0');
    const second = await fetchLeaderboard('?metric=online&period=alltime&limit=2&offset=2');
    const firstBody = first.json() as LeaderboardBody;
    const secondBody = second.json() as LeaderboardBody;
    expect(firstBody.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(secondBody.rows.map((r) => r.rank)).toEqual([3]);
    expect(firstBody.total_pages).toBe(2);
  });

  it('serves the second identical request from the redis cache', async () => {
    const miss = await fetchLeaderboard('?metric=online&period=alltime&limit=5&offset=0');
    const hit = await fetchLeaderboard('?metric=online&period=alltime&limit=5&offset=0');
    expect(miss.headers['x-cache']).toBe('miss');
    expect(hit.headers['x-cache']).toBe('hit');
    expect(hit.json()).toEqual(miss.json());
  });
});
