import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recomputeLeaderboardPeriod } from '../src/leaderboard/aggregate.js';

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
) {
  await sql`
    INSERT INTO player_daily_presence (player_id, server_id, day, online_seconds)
    VALUES (${playerId}, ${serverId}, ${day}::date, ${onlineSeconds})
    ON CONFLICT (player_id, day, server_id)
    DO UPDATE SET online_seconds = EXCLUDED.online_seconds
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
    }[]
  >`
    SELECT player_id, server_id, online_seconds, seeding_seconds, kills, deaths,
           teamkills, revives, kd_ratio::float8 AS kd_ratio, matches_played
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
