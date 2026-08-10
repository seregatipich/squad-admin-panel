import { recomputeLeaderboardPeriod } from '@squad/db';
import { matches, matchPlayers, players, servers } from '@squad/db/schema';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(191001);
const SERVER_ID = '019e0000-0000-7000-8000-0000000001c1';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let rawSql: postgres.Sql;
let ownerCookie: string;
let playerId: string;

interface CombatSummaryBody {
  skill: {
    kills: number;
    deaths: number;
    kd: number;
    teamkills: number;
    revives: number;
    damage_dealt: null;
    matches: number;
    wins: number;
    losses: number;
    draws: number;
    winrate: number | null;
  };
  kd_trend: { month: string; kills: number; deaths: number; kd: number; matches: number }[];
  period: { from: string | null; to: string | null; server_id: string | null };
}

async function seedMatch(
  startedAt: string,
  winner: 'team1' | 'team2' | 'draw' | null,
  seed: { team?: number; kills?: number; deaths?: number },
) {
  const [match] = await h.db
    .insert(matches)
    .values({ serverId: SERVER_ID, startedAt: new Date(startedAt), winner })
    .returning({ id: matches.id });
  await h.db.insert(matchPlayers).values({
    matchId: match.id,
    playerId,
    joinedAt: new Date(startedAt),
    playSeconds: 600,
    team: seed.team ?? null,
    kills: seed.kills ?? null,
    deaths: seed.deaths ?? null,
  });
}

function fetchSummary(query = '', cookie = ownerCookie) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/players/${playerId}/combat-summary${query}`,
    headers: cookie ? { cookie } : undefined,
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  rawSql = postgres(h.url, { max: 1, onnotice: () => undefined });
  ownerCookie = await loginAsOwner(h);

  await h.db.insert(servers).values({ id: SERVER_ID, displayName: 'Combat', slug: 'combat-srv' });
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(191002),
      canonicalName: 'CombatTrend',
      canonicalNameNormalized: 'combattrend',
      eosId: 'eos-combat-trend',
    })
    .returning({ id: players.id });
  playerId = row.id;

  // July 2026: exactly 10 decided-or-drawn matches — 5 wins, 3 losses, 2 draws,
  // each with kills=2, deaths=1 (totals: 20 kills, 10 deaths, kd 2.0).
  const july = (day: number) => `2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  for (let i = 0; i < 5; i += 1) {
    await seedMatch(july(1 + i), 'team1', { team: 1, kills: 2, deaths: 1 });
  }
  for (let i = 0; i < 3; i += 1) {
    await seedMatch(july(6 + i), 'team2', { team: 1, kills: 2, deaths: 1 });
  }
  for (let i = 0; i < 2; i += 1) {
    await seedMatch(july(9 + i), 'draw', { team: 1, kills: 2, deaths: 1 });
  }
  // May 2026: one undecided match (kills=3, deaths=0). June has no events at all.
  await seedMatch('2026-05-10T12:00:00.000Z', null, { team: 1, kills: 3, deaths: 0 });
});

afterAll(async () => {
  await rawSql?.end({ timeout: 5 });
  if (h) await h.cleanup();
});

describeIfDb('GET /api/v1/players/:playerId/combat-summary', () => {
  it('returns skill with 62.5% winrate for 5W/3L/2D over 10 matches', async () => {
    const res = await fetchSummary('?from=2026-07-01&to=2026-07-31');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('miss');
    const body = res.json() as CombatSummaryBody;
    expect(body.skill.matches).toBe(10);
    expect(body.skill.wins).toBe(5);
    expect(body.skill.losses).toBe(3);
    expect(body.skill.draws).toBe(2);
    expect(body.skill.winrate).toBe(0.625);
    expect(body.skill.kills).toBe(20);
    expect(body.skill.deaths).toBe(10);
    expect(body.skill.kd).toBe(2);
    expect(body.skill.teamkills).toBe(0);
    expect(body.skill.revives).toBe(0);
    expect(body.skill.damage_dealt).toBeNull();
    expect(body.period).toEqual({ from: '2026-07-01', to: '2026-07-31', server_id: null });
  });

  it('omits months with no events from kd_trend', async () => {
    for (const periodStart of ['2026-05-01', '2026-06-01', '2026-07-01']) {
      await recomputeLeaderboardPeriod(rawSql, { periodType: 'month', periodStart });
    }

    const res = await fetchSummary();
    expect(res.statusCode).toBe(200);
    const body = res.json() as CombatSummaryBody;
    expect(body.kd_trend.map((t) => t.month)).toEqual(['2026-05-01', '2026-07-01']);
    expect(body.kd_trend[0]).toEqual({
      month: '2026-05-01',
      kills: 3,
      deaths: 0,
      kd: 3,
      matches: 1,
    });
    expect(body.kd_trend[1]).toEqual({
      month: '2026-07-01',
      kills: 20,
      deaths: 10,
      kd: 2,
      matches: 10,
    });
    // The unfiltered skill block spans every month: 11 matches, same 8 decided.
    expect(body.skill.matches).toBe(11);
    expect(body.skill.kills).toBe(23);
    expect(body.skill.winrate).toBe(0.625);
  });

  it('unknown player id returns 404 player_not_found', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/players/019e0000-0000-7000-8000-00000000dead/combat-summary',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'player_not_found' });
  });

  it('unauthenticated → 401; authenticated panel user → 200', async () => {
    const unauthenticated = await fetchSummary('', '');
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await fetchSummary();
    expect(authenticated.statusCode).toBe(200);
  });

  it('second call returns x-cache: hit', async () => {
    const first = await fetchSummary(`?serverId=${SERVER_ID}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');
    expect((first.json() as CombatSummaryBody).period.server_id).toBe(SERVER_ID);

    const second = await fetchSummary(`?serverId=${SERVER_ID}`);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('hit');
    expect(second.json()).toEqual(first.json());
  });
});
