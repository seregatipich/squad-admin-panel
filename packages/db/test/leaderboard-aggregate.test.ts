import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALLTIME_PERIOD_START, recomputeLeaderboardPeriod } from '../src/leaderboard/aggregate.js';

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

async function seedMatch(serverId: string, startedAt: string, playerIds: string[]) {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (server_id, started_at)
    VALUES (${serverId}, ${startedAt}::timestamptz)
    RETURNING id
  `;
  for (const playerId of playerIds) {
    await sql`
      INSERT INTO match_players (match_id, player_id, joined_at, play_seconds)
      VALUES (${match.id}, ${playerId}, ${startedAt}::timestamptz, 600)
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
  it('counts distinct matches per player/server and leaves combat metrics zero', async () => {
    await seedPresence(PLAYER_A, SERVER_1, '2026-07-05', 3600);
    await seedMatch(SERVER_1, '2026-07-05T08:00:00.000Z', [PLAYER_A, PLAYER_B]);
    await seedMatch(SERVER_1, '2026-07-05T09:00:00.000Z', [PLAYER_A]);

    await recomputeLeaderboardPeriod(sql, { periodType: 'day', periodStart: '2026-07-05' });

    const rows = await statRows('day', '2026-07-05');
    const alphaServer1 = rows.find((r) => r.player_id === PLAYER_A && r.server_id === SERVER_1);
    const bravoServer1 = rows.find((r) => r.player_id === PLAYER_B && r.server_id === SERVER_1);
    expect(alphaServer1?.matches_played).toBe(2);
    expect(bravoServer1?.matches_played).toBe(1);
    expect(alphaServer1?.kills).toBe(0);
    expect(alphaServer1?.deaths).toBe(0);
    expect(alphaServer1?.teamkills).toBe(0);
    expect(alphaServer1?.revives).toBe(0);
    expect(bravoServer1?.online_seconds).toBe(0);
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
