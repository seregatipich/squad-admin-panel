import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLTIME_PERIOD_START,
  backfillMonths,
  recomputeLeaderboardPeriod,
} from '../src/leaderboard/aggregate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAT_PERIODS_SQL = readFileSync(
  path.resolve(__dirname, '../sql/player-stat-periods.sql'),
  'utf-8',
);

const PLAYER_A = '0f00000a-0000-4000-8000-000000000001';
const PLAYER_B = '0f00000b-0000-4000-8000-000000000002';
const SERVER_1 = '0f000011-0000-4000-8000-000000000001';
const SERVER_2 = '0f000022-0000-4000-8000-000000000002';

let sql: ReturnType<typeof postgres>;

async function seedPresence(
  playerId: string,
  serverId: string,
  day: string,
  onlineSeconds: number,
  boostSeconds = 0,
  seedSeconds = 0,
) {
  await sql`
    INSERT INTO player_daily_presence
      (player_id, server_id, day, online_seconds, boost_seconds, seed_seconds)
    VALUES (${playerId}, ${serverId}, ${day}::date, ${onlineSeconds}, ${boostSeconds}, ${seedSeconds})
    ON CONFLICT (player_id, day, server_id)
    DO UPDATE SET online_seconds = EXCLUDED.online_seconds,
                  boost_seconds = EXCLUDED.boost_seconds,
                  seed_seconds = EXCLUDED.seed_seconds
  `;
}

async function setEconomyCoefficients(kOnline: number, kBoost: number, kSeed = 3) {
  await sql`
    INSERT INTO economy_settings (id, k_online, k_boost, k_seed)
    VALUES (1, ${kOnline}, ${kBoost}, ${kSeed})
    ON CONFLICT (id) DO UPDATE SET k_online = EXCLUDED.k_online,
                                   k_boost = EXCLUDED.k_boost,
                                   k_seed = EXCLUDED.k_seed
  `;
}

interface MatchPlayerSeed {
  playerId: string;
  team?: number;
  kills?: number;
  deaths?: number;
  teamkills?: number;
  revives?: number;
}

async function seedMatch(
  serverId: string,
  startedAt: string,
  playerSeeds: (string | MatchPlayerSeed)[],
  winner: 'team1' | 'team2' | 'draw' | null = null,
) {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (server_id, started_at, winner)
    VALUES (${serverId}, ${startedAt}::timestamptz, ${winner})
    RETURNING id
  `;
  for (const entry of playerSeeds) {
    const seed = typeof entry === 'string' ? { playerId: entry } : entry;
    await sql`
      INSERT INTO match_players
        (match_id, player_id, joined_at, play_seconds, team, kills, deaths, teamkills, revives)
      VALUES (${match.id}, ${seed.playerId}, ${startedAt}::timestamptz, 600,
              ${seed.team ?? null}, ${seed.kills ?? null}, ${seed.deaths ?? null},
              ${seed.teamkills ?? null}, ${seed.revives ?? null})
    `;
  }
}

async function statRows(periodType: string, periodStart: string) {
  return sql<
    {
      player_id: string;
      server_id: string | null;
      online_seconds: number;
      seeding_seconds: number;
      kills: number;
      deaths: number;
      teamkills: number;
      revives: number;
      kd_ratio: number;
      matches_played: number;
      boost_seconds: number;
      bonus_points: number;
    }[]
  >`
    SELECT player_id, server_id, online_seconds, seeding_seconds, kills, deaths,
           teamkills, revives, kd_ratio::float8 AS kd_ratio, matches_played,
           boost_seconds, bonus_points::float8 AS bonus_points
    FROM player_stat_periods
    WHERE period_type = ${periodType} AND period_start = ${periodStart}::date
    ORDER BY player_id, server_id NULLS LAST
  `;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(STAT_PERIODS_SQL);
  for (const [id, name] of [
    [PLAYER_A, 'Alpha'],
    [PLAYER_B, 'Bravo'],
  ]) {
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized)
      VALUES (${id}, ${name}, ${name.toLowerCase()})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const [id, slug] of [
    [SERVER_1, 'srv-1'],
    [SERVER_2, 'srv-2'],
  ]) {
    await sql`
      INSERT INTO servers (id, display_name, slug)
      VALUES (${id}, ${slug}, ${slug})
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

async function resetOwnData() {
  await sql`TRUNCATE player_stat_periods`;
  await sql`DELETE FROM matches WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM player_daily_presence WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE canonical_name LIKE 'lbbulk%'`;
  await setEconomyCoefficients(1, 2);
}

afterAll(async () => {
  if (!sql) return;
  await resetOwnData();
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B]})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await resetOwnData();
});

describeIfDb('player_stat_periods table shape', () => {
  it('uses a NULLS NOT DISTINCT identity so one rollup row exists per key', async () => {
    const [meta] = await sql<{ indnullsnotdistinct: boolean }[]>`
      SELECT i.indnullsnotdistinct
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'player_stat_periods_identity'
    `;
    expect(meta.indnullsnotdistinct).toBe(true);
  });

  it('rejects negative metrics via the check constraint', async () => {
    await expect(
      sql`INSERT INTO player_stat_periods (player_id, server_id, period_type, period_start, online_seconds)
          VALUES (${PLAYER_A}, ${SERVER_1}, 'day', '2026-07-05', -1)`,
    ).rejects.toThrow(/player_stat_periods_metrics_chk/);
  });
});

describeIfDb('recomputeLeaderboardPeriod reconciliation', () => {
  it('per-server online_seconds reconciles with player_daily_presence', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600);
    await seedPresence(PLAYER_A, SERVER_2, '2026-07-05', 1800);
    await seedPresence(PLAYER_B, SERVER_1, '2026-07-05', 900);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const [statSum] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(online_seconds), 0)::bigint AS total
      FROM player_stat_periods
      WHERE period_type = 'day' AND period_start = '2026-07-05' AND server_id IS NOT NULL
    `;
    const [presenceSum] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(online_seconds), 0)::bigint AS total
      FROM player_daily_presence WHERE day = '2026-07-05'
    `;
    expect(Number(statSum.total)).toBe(Number(presenceSum.total));
    expect(Number(statSum.total)).toBe(6300);
  });

  it('rollup (server_id NULL) sums the per-server rows and recomputes kd', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600);
    await seedPresence(PLAYER_A, SERVER_2, '2026-07-05', 1800);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const perServer = rows.filter((r) => r.server_id !== null);
    const rollup = rows.find((r) => r.server_id === null && r.player_id === PLAYER_A);
    expect(perServer).toHaveLength(2);
    expect(rollup?.online_seconds).toBe(5400);
    expect(rollup?.kd_ratio).toBe(0);
  });
});

describeIfDb('cross-midnight session lands in both days and once in the week', () => {
  it('splits into two day rows and aggregates once into the week', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-04', 3600);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-04' });
    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });
    await recomputeLeaderboardPeriod(sql, { periodType: 'week', periodStart: '2026-06-29' });

    const saturday = await statRows('day', '2026-07-04');
    const sunday = await statRows('day', '2026-07-05');
    const week = await statRows('week', '2026-06-29');

    expect(saturday.find((r) => r.server_id === SERVER_1)?.online_seconds).toBe(3600);
    expect(sunday.find((r) => r.server_id === SERVER_1)?.online_seconds).toBe(3600);

    const weekPerServer = week.filter((r) => r.server_id === SERVER_1 && r.player_id === PLAYER_A);
    expect(weekPerServer).toHaveLength(1);
    expect(weekPerServer[0]?.online_seconds).toBe(7200);
  });
});

describeIfDb('recompute idempotency', () => {
  it('produces identical rows when run twice', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-06-30', 1200);
    await seedPresence(PLAYER_B, SERVER_2, '2026-07-02', 800);

    await recomputeLeaderboardPeriod(sql, { periodType: 'week', periodStart: '2026-06-29' });
    const first = await statRows('week', '2026-06-29');
    await recomputeLeaderboardPeriod(sql, { periodType: 'week', periodStart: '2026-06-29' });
    const second = await statRows('week', '2026-06-29');

    expect(second).toStrictEqual(first);
  });
});

describeIfDb('matches_played and combat availability', () => {
  it('counts distinct matches per player/server', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600);
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [PLAYER_A, PLAYER_B]);
    await seedMatch(SERVER_1, '2026-07-05T09:00:00.000Z', [PLAYER_A]);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const alphaServer1 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    const bravoServer1 = rows.find((r) => r.player_id === PLAYER_B && r.server_id === SERVER_1);
    expect(alphaServer1?.matches_played).toBe(2);
    expect(bravoServer1?.matches_played).toBe(1);
    expect(bravoServer1?.online_seconds).toBe(0);
  });
});

describeIfDb('combat aggregation (DOSSIER-4)', () => {
  it('aggregates combat columns from match_players into month rows', async () => {
    // June: one match on SERVER_1. July: two matches split across two servers.
    await seedMatch(SERVER_1, '2026-06-10T18:00:00.000Z', [
      { playerId: PLAYER_A, kills: 5, deaths: 2, teamkills: 1, revives: 3 },
    ]);
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [
      { playerId: PLAYER_A, kills: 4, deaths: 3 },
      { playerId: PLAYER_B, kills: 2, deaths: 1, revives: 6 },
    ]);
    await seedMatch(SERVER_2, '2026-07-20T09:00:00.000Z', [
      { playerId: PLAYER_A, kills: 3, deaths: 1, teamkills: 2 },
    ]);

    await recomputeLeaderboardPeriod(sql, { periodType: 'month', periodStart: '2026-06-01' });
    await recomputeLeaderboardPeriod(sql, { periodType: 'month', periodStart: '2026-07-01' });

    // Events from two different months land in two separate month rows.
    const june = await statRows('month', '2026-06-01');
    const july = await statRows('month', '2026-07-01');
    const juneA = june.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    expect(juneA?.kills).toBe(5);
    expect(juneA?.deaths).toBe(2);
    expect(juneA?.teamkills).toBe(1);
    expect(juneA?.revives).toBe(3);
    expect(juneA?.kd_ratio).toBe(2.5);

    const julyAServer1 = july.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    const julyAServer2 = july.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_2);
    const julyARollup = july.find((r) => r.player_id === PLAYER_A && r.server_id === null);
    const julyBServer1 = july.find((r) => r.player_id === PLAYER_B && r.server_id === SERVER_1);
    expect(julyAServer1?.kills).toBe(4);
    expect(julyAServer2?.kills).toBe(3);
    // The all-servers rollup sums the per-server combat rows and recomputes kd.
    expect(julyARollup?.kills).toBe(7);
    expect(julyARollup?.deaths).toBe(4);
    expect(julyARollup?.teamkills).toBe(2);
    expect(julyARollup?.kd_ratio).toBe(7 / 4);
    expect(julyBServer1?.revives).toBe(6);

    // The materialised monthly kills reconcile with a manual sum over match_players.
    const [manual] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(mp.kills), 0)::bigint AS total
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      WHERE m.server_id = ANY(${[SERVER_1, SERVER_2]})
    `;
    const [materialised] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(kills), 0)::bigint AS total
      FROM player_stat_periods
      WHERE period_type = 'month' AND server_id IS NOT NULL
    `;
    expect(Number(materialised.total)).toBe(Number(manual.total));
    expect(Number(materialised.total)).toBe(14);
  });

  it('kd_ratio uses kills when deaths is zero', async () => {
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [
      { playerId: PLAYER_A, kills: 4, deaths: 0 },
    ]);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const server1 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    expect(server1?.kills).toBe(4);
    expect(server1?.deaths).toBe(0);
    expect(server1?.kd_ratio).toBe(4);
  });

  it('players without combat rows keep zero metrics', async () => {
    // match_players combat columns are nullable; a row with no recorded combat
    // must COALESCE to zero, and presence-only players must stay at zero too.
    await seedPresence(PLAYER_B, SERVER_2, '2026-07-05', 900);
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [PLAYER_A]);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const alphaServer1 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    const bravoServer2 = rows.find((r) => r.player_id === PLAYER_B && r.server_id === SERVER_2);
    for (const row of [alphaServer1, bravoServer2]) {
      expect(row?.kills).toBe(0);
      expect(row?.deaths).toBe(0);
      expect(row?.teamkills).toBe(0);
      expect(row?.revives).toBe(0);
      expect(row?.kd_ratio).toBe(0);
    }
    expect(alphaServer1?.matches_played).toBe(1);
  });

  it('backfillMonths recomputes the last N month periods and is a no-op for zero', async () => {
    await seedMatch(SERVER_1, '2026-06-10T18:00:00.000Z', [
      { playerId: PLAYER_A, kills: 5, deaths: 2 },
    ]);
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [
      { playerId: PLAYER_A, kills: 4, deaths: 1 },
    ]);

    const now = new Date('2026-07-26T12:00:00.000Z');
    expect(await backfillMonths(sql, 0, now)).toBe(0);

    const written = await backfillMonths(sql, 2, now);
    expect(written).toBeGreaterThan(0);

    const june = await statRows('month', '2026-06-01');
    const july = await statRows('month', '2026-07-01');
    expect(june.find((r) => r.server_id === SERVER_1)?.kills).toBe(5);
    expect(july.find((r) => r.server_id === SERVER_1)?.kills).toBe(4);
  });
});

describeIfDb('bonus/boost accrual (LEAD-4)', () => {
  it('materialises boost_seconds and accrues bonus_points from economy coefficients', async () => {
    await setEconomyCoefficients(1, 2);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600, 600);
    await seedPresence(PLAYER_A, SERVER_2, '2026-07-05', 1800, 300);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const server1 = rows.find((r) => r.server_id === SERVER_1 && r.player_id === PLAYER_A);
    const server2 = rows.find((r) => r.server_id === SERVER_2 && r.player_id === PLAYER_A);
    const rollup = rows.find((r) => r.server_id === null && r.player_id === PLAYER_A);

    expect(server1?.boost_seconds).toBe(600);
    // bonus = k_online * online + k_boost * boost = 1*3600 + 2*600
    expect(server1?.bonus_points).toBe(4800);
    expect(server2?.bonus_points).toBe(1800 + 2 * 300);

    // rollup sums both servers for boost and bonus.
    expect(rollup?.boost_seconds).toBe(900);
    expect(rollup?.bonus_points).toBe(4800 + 2400);
  });

  it('applies changed coefficients only when a period is recomputed (frozen otherwise)', async () => {
    await setEconomyCoefficients(1, 2);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 1000, 100);
    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const before = await statRows('day', '2026-07-05');
    const beforeRow = before.find((r) => r.server_id === SERVER_1);
    expect(beforeRow?.bonus_points).toBe(1000 + 2 * 100);

    // Owner raises the boost multiplier. Until the period is recomputed, the stored
    // bonus stays frozen — closed periods are never re-passed to the aggregator.
    await setEconomyCoefficients(1, 10);
    const frozen = await statRows('day', '2026-07-05');
    expect(frozen.find((r) => r.server_id === SERVER_1)?.bonus_points).toBe(1200);

    // Recomputing the (still open) period applies the new coefficient to future accruals.
    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });
    const after = await statRows('day', '2026-07-05');
    expect(after.find((r) => r.server_id === SERVER_1)?.bonus_points).toBe(1000 + 10 * 100);
  });
});

describeIfDb('seeding contribution (LEAD-6)', () => {
  it('materialises per-server seeding_seconds and sums them into the rollup', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600, 0, 1200);
    await seedPresence(PLAYER_A, SERVER_2, '2026-07-05', 1800, 0, 600);
    await seedPresence(PLAYER_B, SERVER_1, '2026-07-05', 900, 0, 300);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const aServer1 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    const aServer2 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_2);
    const aRollup = rows.find((r) => r.player_id === PLAYER_A && r.server_id === null);
    const bServer1 = rows.find((r) => r.player_id === PLAYER_B && r.server_id === SERVER_1);

    // Per-server seeding_seconds matches the presence rows exactly.
    expect(aServer1?.seeding_seconds).toBe(1200);
    expect(aServer2?.seeding_seconds).toBe(600);
    expect(bServer1?.seeding_seconds).toBe(300);
    // The NULL-server rollup is the sum of the player's per-server rows.
    expect(aRollup?.seeding_seconds).toBe(1800);

    // The materialised total reconciles with player_daily_presence.
    const [presenceSum] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(seed_seconds), 0)::bigint AS total
      FROM player_daily_presence WHERE day = '2026-07-05'
    `;
    const [statSum] = await sql<{ total: number }[]>`
      SELECT COALESCE(SUM(seeding_seconds), 0)::bigint AS total
      FROM player_stat_periods
      WHERE period_type = 'day' AND period_start = '2026-07-05' AND server_id IS NOT NULL
    `;
    expect(Number(statSum.total)).toBe(Number(presenceSum.total));
    expect(Number(statSum.total)).toBe(2100);
  });

  it('ranks weekly top seeders by seeding_seconds with hand-computed totals', async () => {
    // PLAYER_A seeds across two days on one server → 1000 + 2000 = 3000 for the week.
    await seedPresence(PLAYER_A, SERVER_1, '2026-06-30', 0, 0, 1000);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-01', 0, 0, 2000);
    // PLAYER_B seeds 4000 on a single day → outranks PLAYER_A.
    await seedPresence(PLAYER_B, SERVER_1, '2026-07-02', 0, 0, 4000);

    await recomputeLeaderboardPeriod(sql, { periodType: 'week', periodStart: '2026-06-29' });

    const top = await sql<{ player_id: string; seeding_seconds: number }[]>`
      SELECT player_id, seeding_seconds
      FROM player_stat_periods
      WHERE period_type = 'week' AND period_start = '2026-06-29' AND server_id IS NULL
      ORDER BY seeding_seconds DESC
    `;
    expect(top.map((r) => r.player_id)).toEqual([PLAYER_B, PLAYER_A]);
    expect(top[0]?.seeding_seconds).toBe(4000);
    expect(top[1]?.seeding_seconds).toBe(3000);
  });

  it('adds k_seed × seed to bonus_points alongside online and boost', async () => {
    await setEconomyCoefficients(1, 2, 3);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600, 600, 1200);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const server1 = rows.find((r) => r.server_id === SERVER_1 && r.player_id === PLAYER_A);
    expect(server1?.seeding_seconds).toBe(1200);
    // bonus = k_online*online + k_boost*boost + k_seed*seed = 1*3600 + 2*600 + 3*1200
    expect(server1?.bonus_points).toBe(1 * 3600 + 2 * 600 + 3 * 1200);
  });

  it('freezes seeding_seconds and its bonus until the period is recomputed', async () => {
    await setEconomyCoefficients(1, 2, 3);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 0, 0, 1000);
    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const before = (await statRows('day', '2026-07-05')).find((r) => r.server_id === SERVER_1);
    expect(before?.seeding_seconds).toBe(1000);
    expect(before?.bonus_points).toBe(3 * 1000);

    // Owner raises k_seed; the stored row stays frozen until an explicit recompute.
    await setEconomyCoefficients(1, 2, 9);
    const frozen = (await statRows('day', '2026-07-05')).find((r) => r.server_id === SERVER_1);
    expect(frozen?.bonus_points).toBe(3 * 1000);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });
    const after = (await statRows('day', '2026-07-05')).find((r) => r.server_id === SERVER_1);
    expect(after?.bonus_points).toBe(9 * 1000);
    // seeding_seconds is sourced from presence and is unaffected by k_seed.
    expect(after?.seeding_seconds).toBe(1000);
  });

  it('stores zero seeding_seconds without a constraint violation and is idempotent', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600); // seedSeconds defaults to 0

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });
    const first = await statRows('day', '2026-07-05');
    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });
    const second = await statRows('day', '2026-07-05');

    expect(first.find((r) => r.server_id === SERVER_1)?.seeding_seconds).toBe(0);
    expect(second).toStrictEqual(first);
  });

  it('sums seeding_seconds across every day for the alltime period', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-04', 0, 0, 500);
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 0, 0, 700);

    await recomputeLeaderboardPeriod(sql, {
      periodType: 'alltime',
      periodStart: ALLTIME_PERIOD_START,
    });

    const rows = await statRows('alltime', ALLTIME_PERIOD_START);
    const server1 = rows.find((r) => r.server_id === SERVER_1 && r.player_id === PLAYER_A);
    const rollup = rows.find((r) => r.server_id === null && r.player_id === PLAYER_A);
    expect(server1?.seeding_seconds).toBe(1200);
    expect(rollup?.seeding_seconds).toBe(1200);
  });
});

describeIfDb('top-N query uses the metric index', () => {
  it('EXPLAIN of a top-100 online query hits the index without a seq scan', async () => {
    try {
      await sql`
        INSERT INTO players (id, canonical_name, canonical_name_normalized)
        SELECT gen_random_uuid(), 'lbbulk' || g, 'lbbulk' || g
        FROM generate_series(1, 3000) AS g
      `;
      await sql`
        INSERT INTO player_stat_periods
          (player_id, server_id, period_type, period_start, online_seconds)
        SELECT p.id, ${SERVER_1}, 'day', '2026-07-05', (random() * 100000)::int
        FROM players p
        WHERE p.canonical_name LIKE 'lbbulk%'
      `;
      await sql`ANALYZE player_stat_periods`;

      const plan = await sql<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT player_id, online_seconds
        FROM player_stat_periods
        WHERE period_type = 'day' AND period_start = '2026-07-05' AND server_id = ${SERVER_1}
        ORDER BY online_seconds DESC
        LIMIT 100
      `;
      const planText = plan.map((line) => line['QUERY PLAN']).join('\n');

      expect(planText).toMatch(/player_stat_periods_online_idx/);
      expect(planText).not.toMatch(/Seq Scan on player_stat_periods/);
    } finally {
      await sql`DELETE FROM players WHERE canonical_name LIKE 'lbbulk%'`;
    }
  }, 30_000);
});
