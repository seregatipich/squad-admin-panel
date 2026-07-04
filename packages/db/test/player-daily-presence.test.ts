import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  recomputeDailyPresence,
  recomputeDailyPresenceForAllSessions,
} from '../src/presence/daily.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_SQL = readFileSync(path.resolve(__dirname, '../sql/player-sessions.sql'), 'utf-8');
const DAILY_SQL = readFileSync(
  path.resolve(__dirname, '../sql/player-daily-presence.sql'),
  'utf-8',
);

const PLAYER_A = '000000a1-0000-4000-8000-000000000000';
const PLAYER_B = '000000b2-0000-4000-8000-000000000000';
const SERVER_1 = '00000011-0000-4000-8000-000000000000';
const SERVER_2 = '00000022-0000-4000-8000-000000000000';

const NOW = new Date('2026-07-10T00:00:00.000Z');

let sql: ReturnType<typeof postgres>;

interface SeedSession {
  playerId: string;
  serverId: string;
  connectedAt: string;
  disconnectedAt?: string;
  mode?: string;
}

async function seedSession(session: SeedSession) {
  const disconnectedAt = session.disconnectedAt ?? null;
  await sql`
    INSERT INTO player_sessions
      (player_id, server_id, connected_at, disconnected_at, duration_seconds, closed_reason, mode)
    VALUES (
      ${session.playerId},
      ${session.serverId},
      ${session.connectedAt}::timestamptz,
      ${disconnectedAt}::timestamptz,
      CASE WHEN ${disconnectedAt}::timestamptz IS NULL THEN NULL
           ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${disconnectedAt}::timestamptz - ${session.connectedAt}::timestamptz))))::int END,
      CASE WHEN ${disconnectedAt}::timestamptz IS NULL THEN NULL ELSE 'disconnect' END,
      ${session.mode ?? 'online'}
    )
  `;
}

async function dailyRows() {
  return sql<
    {
      player_id: string;
      server_id: string;
      day: string;
      online_seconds: number;
      boost_seconds: number;
      queue_seconds: number;
      session_count: number;
    }[]
  >`
    SELECT player_id, server_id, day::text AS day,
           online_seconds, boost_seconds, queue_seconds, session_count
    FROM player_daily_presence
    ORDER BY player_id, day, server_id
  `;
}

async function sumDaily(): Promise<number> {
  const [row] = await sql<{ total: number | null }[]>`
    SELECT COALESCE(SUM(online_seconds + boost_seconds + queue_seconds), 0)::bigint AS total
    FROM player_daily_presence
  `;
  return Number(row.total ?? 0);
}

async function sumSessions(): Promise<number> {
  const [row] = await sql<{ total: number | null }[]>`
    SELECT COALESCE(SUM(duration_seconds), 0)::bigint AS total
    FROM player_sessions
    WHERE duration_seconds IS NOT NULL
  `;
  return Number(row.total ?? 0);
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(SESSIONS_SQL);
  await sql.unsafe(DAILY_SQL);
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

afterAll(async () => {
  if (!sql) return;
  await sql`TRUNCATE player_daily_presence`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B]})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE player_daily_presence`;
  await sql`TRUNCATE player_sessions`;
  await sql`UPDATE players SET total_time_played_seconds = 0`;
});

describeIfDb('player_daily_presence table shape', () => {
  it('has the composite (player_id, day, server_id) primary key', async () => {
    const [pk] = await sql<{ cols: string }[]>`
      SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'player_daily_presence'::regclass AND i.indisprimary
    `;
    expect(pk.cols).toBe('player_id,day,server_id');
  });

  it('rejects negative aggregate seconds via the check constraint', async () => {
    await expect(
      sql`INSERT INTO player_daily_presence (player_id, day, server_id, online_seconds)
          VALUES (${PLAYER_A}, '2026-07-05', ${SERVER_1}, -1)`,
    ).rejects.toThrow(/player_daily_presence_seconds_chk/);
  });
});

describeIfDb('recomputeDailyPresence cross-midnight splitting', () => {
  it('gives a 23:00-01:00 session ~1h to each of the two days', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T23:00:00.000Z',
      disconnectedAt: '2026-07-05T01:00:00.000Z',
    });

    await recomputeDailyPresence(sql, { fromDay: '2026-07-04', toDay: '2026-07-05', now: NOW });

    const rows = await dailyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      day: '2026-07-04',
      online_seconds: 3600,
      session_count: 1,
    });
    expect(rows[1]).toMatchObject({
      day: '2026-07-05',
      online_seconds: 3600,
      session_count: 1,
    });
  });

  it('buckets boost and queue sessions into their own columns', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T08:00:00.000Z',
      disconnectedAt: '2026-07-05T09:00:00.000Z',
      mode: 'boost',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T10:30:00.000Z',
      mode: 'queue',
    });

    await recomputeDailyPresence(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });

    const [row] = await dailyRows();
    expect(row).toMatchObject({
      day: '2026-07-05',
      online_seconds: 0,
      boost_seconds: 3600,
      queue_seconds: 1800,
      session_count: 2,
    });
  });

  it('keeps different servers on separate rows for the same player/day', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T08:00:00.000Z',
      disconnectedAt: '2026-07-05T09:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_2,
      connectedAt: '2026-07-05T08:00:00.000Z',
      disconnectedAt: '2026-07-05T08:30:00.000Z',
    });

    await recomputeDailyPresence(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });

    const rows = await dailyRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.server_id, r.online_seconds])).toEqual([
      [SERVER_1, 3600],
      [SERVER_2, 1800],
    ]);
  });

  it('counts an open session up to now on the current day', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-09T23:00:00.000Z',
    });

    await recomputeDailyPresence(sql, { fromDay: '2026-07-09', toDay: '2026-07-10', now: NOW });

    const rows = await dailyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-07-09', online_seconds: 3600 });
  });
});

describeIfDb('recomputeDailyPresence reconciliation and idempotency', () => {
  const scenario = async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T22:00:00.000Z',
      disconnectedAt: '2026-07-06T02:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T12:00:00.000Z',
      disconnectedAt: '2026-07-05T13:37:11.000Z',
      mode: 'boost',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_2,
      connectedAt: '2026-07-05T23:59:59.500Z',
      disconnectedAt: '2026-07-06T00:00:03.500Z',
    });
  };

  it('reconciles SUM(aggregates) with SUM(sessions)', async () => {
    await scenario();
    await recomputeDailyPresenceForAllSessions(sql, NOW);
    expect(await sumDaily()).toBe(await sumSessions());
  });

  it('is idempotent: running twice yields identical rows', async () => {
    await scenario();
    await recomputeDailyPresenceForAllSessions(sql, NOW);
    const first = await dailyRows();
    await recomputeDailyPresenceForAllSessions(sql, NOW);
    const second = await dailyRows();
    expect(second).toEqual(first);
  });

  it('re-running a narrower window does not double count or drop rows', async () => {
    await scenario();
    await recomputeDailyPresenceForAllSessions(sql, NOW);
    const baseline = await dailyRows();

    await recomputeDailyPresence(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });
    const afterPartial = await dailyRows();

    expect(afterPartial).toEqual(baseline);
    expect(await sumDaily()).toBe(await sumSessions());
  });
});

describeIfDb('total_time_played_seconds sync', () => {
  it('sets each player total to the sum of their closed session durations', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T23:00:00.000Z',
      disconnectedAt: '2026-07-05T01:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T10:30:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T12:00:00.000Z',
      disconnectedAt: '2026-07-05T13:00:00.000Z',
    });

    await recomputeDailyPresenceForAllSessions(sql, NOW);

    const totals = await sql<{ id: string; total_time_played_seconds: number }[]>`
      SELECT id, total_time_played_seconds FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B]})
      ORDER BY id
    `;
    const byId = new Map(totals.map((t) => [t.id, Number(t.total_time_played_seconds)]));
    expect(byId.get(PLAYER_A)).toBe(7200 + 1800);
    expect(byId.get(PLAYER_B)).toBe(3600);
  });

  it('does not increment on repeated recompute (idempotent totals)', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T11:00:00.000Z',
    });

    await recomputeDailyPresenceForAllSessions(sql, NOW);
    await recomputeDailyPresenceForAllSessions(sql, NOW);

    const [row] = await sql<{ total_time_played_seconds: number }[]>`
      SELECT total_time_played_seconds FROM players WHERE id = ${PLAYER_A}
    `;
    expect(Number(row.total_time_played_seconds)).toBe(3600);
  });
});
