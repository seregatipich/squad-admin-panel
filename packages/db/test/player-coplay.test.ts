import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recomputeCoplayForAllSessions, recomputeCoplayWindow } from '../src/coplay/aggregate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_SQL = readFileSync(path.resolve(__dirname, '../sql/player-sessions.sql'), 'utf-8');
const COPLAY_SQL = readFileSync(path.resolve(__dirname, '../sql/player-coplay.sql'), 'utf-8');

// Fixed IDs chosen so PLAYER_A < PLAYER_B < PLAYER_C as uuids (canonical order).
const PLAYER_A = '000000a1-0000-4000-8000-000000000000';
const PLAYER_B = '000000b2-0000-4000-8000-000000000000';
const PLAYER_C = '000000c3-0000-4000-8000-000000000000';
const SERVER_1 = '00000011-0000-4000-8000-000000000000';
const SERVER_2 = '00000022-0000-4000-8000-000000000000';
const ALL_PLAYERS = [PLAYER_A, PLAYER_B, PLAYER_C];
const ALL_SERVERS = [SERVER_1, SERVER_2];

const NOW = new Date('2026-07-10T00:00:00.000Z');

let sql: ReturnType<typeof postgres>;

interface SeedSession {
  playerId: string;
  serverId: string;
  connectedAt: string;
  disconnectedAt?: string;
}

async function seedSession(s: SeedSession) {
  const disconnectedAt = s.disconnectedAt ?? null;
  await sql`
    INSERT INTO player_sessions
      (player_id, server_id, connected_at, disconnected_at, duration_seconds, closed_reason, mode)
    VALUES (
      ${s.playerId}, ${s.serverId}, ${s.connectedAt}::timestamptz, ${disconnectedAt}::timestamptz,
      CASE WHEN ${disconnectedAt}::timestamptz IS NULL THEN NULL
           ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${disconnectedAt}::timestamptz - ${s.connectedAt}::timestamptz))))::int END,
      CASE WHEN ${disconnectedAt}::timestamptz IS NULL THEN NULL ELSE 'disconnect' END,
      'online'
    )
  `;
}

interface CoplayRow {
  player_a_id: string;
  player_b_id: string;
  server_id: string;
  window_start: string;
  overlap_seconds: number;
  shared_session_count: number;
}

async function coplayRows(): Promise<CoplayRow[]> {
  return sql<CoplayRow[]>`
    SELECT player_a_id, player_b_id, server_id, window_start::text AS window_start,
           overlap_seconds::bigint AS overlap_seconds, shared_session_count
    FROM player_coplay
    ORDER BY player_a_id, player_b_id, server_id, window_start
  `.then((rows) => rows.map((r) => ({ ...r, overlap_seconds: Number(r.overlap_seconds) })));
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(SESSIONS_SQL);
  await sql.unsafe(COPLAY_SQL);
  for (const [id, name] of [
    [PLAYER_A, 'Alpha'],
    [PLAYER_B, 'Bravo'],
    [PLAYER_C, 'Charlie'],
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
  await sql`TRUNCATE player_coplay`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM servers WHERE id = ANY(${ALL_SERVERS})`;
  await sql`DELETE FROM players WHERE id = ANY(${ALL_PLAYERS})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE player_coplay`;
  await sql`TRUNCATE player_sessions`;
});

describeIfDb('player_coplay table shape', () => {
  it('has the composite (a, b, server, window_start) primary key', async () => {
    const [pk] = await sql<{ cols: string }[]>`
      SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'player_coplay'::regclass AND i.indisprimary
    `;
    expect(pk.cols).toBe('player_a_id,player_b_id,server_id,window_start');
  });

  it('rejects a row where player_a_id >= player_b_id (order check)', async () => {
    await expect(
      sql`INSERT INTO player_coplay (player_a_id, player_b_id, server_id, window_start)
          VALUES (${PLAYER_B}, ${PLAYER_A}, ${SERVER_1}, '2026-07-05')`,
    ).rejects.toThrow(/player_coplay_order_chk/);
  });

  it('rejects negative overlap via the nonneg check', async () => {
    await expect(
      sql`INSERT INTO player_coplay
            (player_a_id, player_b_id, server_id, window_start, overlap_seconds)
          VALUES (${PLAYER_A}, ${PLAYER_B}, ${SERVER_1}, '2026-07-05', -1)`,
    ).rejects.toThrow(/player_coplay_nonneg_chk/);
  });
});

describeIfDb('recomputeCoplayWindow', () => {
  it('records the clipped simultaneous overlap once per pair with a<b ordering', async () => {
    // A: 10:00-12:00, B: 11:00-13:00 -> overlap 11:00-12:00 = 3600s
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T11:00:00.000Z',
      disconnectedAt: '2026-07-05T13:00:00.000Z',
    });

    const written = await recomputeCoplayWindow(sql, {
      fromDay: '2026-07-05',
      toDay: '2026-07-05',
      now: NOW,
    });

    expect(written).toBe(1);
    const rows = await coplayRows();
    expect(rows).toEqual([
      {
        player_a_id: PLAYER_A,
        player_b_id: PLAYER_B,
        server_id: SERVER_1,
        window_start: '2026-07-05',
        overlap_seconds: 3600,
        shared_session_count: 1,
      },
    ]);
  });

  it('does not pair players who were on different servers', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_2,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T12:00:00.000Z',
    });

    await recomputeCoplayWindow(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });
    expect(await coplayRows()).toEqual([]);
  });

  it('splits a cross-midnight overlap into one bucket per UTC day', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T23:00:00.000Z',
      disconnectedAt: '2026-07-05T01:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T22:30:00.000Z',
      disconnectedAt: '2026-07-05T02:00:00.000Z',
    });

    await recomputeCoplayWindow(sql, { fromDay: '2026-07-04', toDay: '2026-07-05', now: NOW });
    const rows = await coplayRows();
    expect(rows.map((r) => [r.window_start, r.overlap_seconds])).toEqual([
      ['2026-07-04', 3600],
      ['2026-07-05', 3600],
    ]);
  });

  it('aggregates 10 shared sessions into one bucket, readable from either side (AC)', async () => {
    // 10 back-to-back 6-minute overlaps on the same day -> 10 sessions, 3600s.
    for (let i = 0; i < 10; i++) {
      const start = `2026-07-05T${String(10 + i).padStart(2, '0')}:00:00.000Z`;
      const end = `2026-07-05T${String(10 + i).padStart(2, '0')}:06:00.000Z`;
      await seedSession({
        playerId: PLAYER_A,
        serverId: SERVER_1,
        connectedAt: start,
        disconnectedAt: end,
      });
      await seedSession({
        playerId: PLAYER_B,
        serverId: SERVER_1,
        connectedAt: start,
        disconnectedAt: end,
      });
    }

    await recomputeCoplayWindow(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });

    const [fromA] = await sql<{ overlap: number; count: number }[]>`
      SELECT overlap_seconds::bigint AS overlap, shared_session_count AS count
      FROM player_coplay WHERE player_a_id = ${PLAYER_A}
    `;
    const [fromB] = await sql<{ overlap: number; count: number }[]>`
      SELECT overlap_seconds::bigint AS overlap, shared_session_count AS count
      FROM player_coplay WHERE player_b_id = ${PLAYER_B}
    `;
    expect(Number(fromA.overlap)).toBe(3600);
    expect(fromA.count).toBe(10);
    // Same physical row is visible from either player's perspective.
    expect(Number(fromB.overlap)).toBe(Number(fromA.overlap));
    expect(fromB.count).toBe(fromA.count);
  });

  it('reconciles: full-window rebuild equals the sum of daily increments', async () => {
    // Overlaps spread across three days on two servers, three pairs.
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-03T10:00:00.000Z',
      disconnectedAt: '2026-07-03T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-03T11:00:00.000Z',
      disconnectedAt: '2026-07-03T13:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_2,
      connectedAt: '2026-07-04T20:00:00.000Z',
      disconnectedAt: '2026-07-05T01:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_C,
      serverId: SERVER_2,
      connectedAt: '2026-07-04T21:00:00.000Z',
      disconnectedAt: '2026-07-05T00:30:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T08:00:00.000Z',
      disconnectedAt: '2026-07-05T10:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_C,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T09:00:00.000Z',
      disconnectedAt: '2026-07-05T11:00:00.000Z',
    });

    await recomputeCoplayWindow(sql, { fromDay: '2026-07-03', toDay: '2026-07-05', now: NOW });
    const full = await coplayRows();

    await sql`TRUNCATE player_coplay`;
    for (const day of ['2026-07-03', '2026-07-04', '2026-07-05']) {
      await recomputeCoplayWindow(sql, { fromDay: day, toDay: day, now: NOW });
    }
    const incremental = await coplayRows();

    expect(incremental).toEqual(full);
    expect(full.length).toBeGreaterThan(0);
  });

  it('is idempotent: rerunning the same window does not duplicate rows', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:00:00.000Z',
      disconnectedAt: '2026-07-05T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-05T10:30:00.000Z',
      disconnectedAt: '2026-07-05T11:30:00.000Z',
    });

    await recomputeCoplayWindow(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });
    const first = await coplayRows();
    await recomputeCoplayWindow(sql, { fromDay: '2026-07-05', toDay: '2026-07-05', now: NOW });
    const second = await coplayRows();

    expect(second).toEqual(first);
  });

  it('recomputeCoplayForAllSessions rebuilds across the full session history', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-01T10:00:00.000Z',
      disconnectedAt: '2026-07-01T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-01T11:00:00.000Z',
      disconnectedAt: '2026-07-01T13:00:00.000Z',
    });

    const written = await recomputeCoplayForAllSessions(sql, NOW);
    expect(written).toBe(1);
    const [row] = await coplayRows();
    expect(row.overlap_seconds).toBe(3600);
    expect(row.window_start).toBe('2026-07-01');
  });
});
