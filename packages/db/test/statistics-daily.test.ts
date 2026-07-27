import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recomputeServerDailyStats } from '../src/statistics/daily.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PLAYER_A = '000009a1-0000-4000-8000-000000000000';
const PLAYER_B = '000009b2-0000-4000-8000-000000000000';
const PLAYER_C = '000009c3-0000-4000-8000-000000000000';
const ADMIN_P = '000009d4-0000-4000-8000-000000000000';
const SERVER_1 = '00000991-0000-4000-8000-000000000000';
const SERVER_2 = '00000992-0000-4000-8000-000000000000';
const ADMIN_ROLE = '000009e5-0000-4000-8000-000000000000';

/** Every fixture day is fully in the past relative to NOW, so the day span is a full 86 400 s. */
const NOW = new Date('2026-07-10T12:00:00.000Z');
const FROM_DAY = '2026-07-04';
const TO_DAY = '2026-07-05';

let sql: ReturnType<typeof postgres>;

interface StatsRow {
  server_id: string;
  day: string;
  avg_online: number;
  peak_online: number;
  avg_queue: number;
  online_seconds: string | number;
  matches: number;
  modes: Record<string, number>;
  maps: Record<string, number>;
  new_players: number;
  chat_messages: number;
  teamkills: number;
  punishments: number;
  avg_admins: number;
  peak_admins: number;
}

async function statsRows(): Promise<StatsRow[]> {
  return sql<StatsRow[]>`
    SELECT server_id, day::text AS day, avg_online, peak_online, avg_queue, online_seconds,
           matches, modes, maps, new_players, chat_messages, teamkills, punishments,
           avg_admins, peak_admins
    FROM server_daily_stats
    ORDER BY day, server_id
  ` as unknown as Promise<StatsRow[]>;
}

async function rowFor(serverId: string, day: string): Promise<StatsRow> {
  const rows = await statsRows();
  const row = rows.find((r) => r.server_id === serverId && r.day === day);
  if (!row) throw new Error(`no server_daily_stats row for ${serverId} / ${day}`);
  return row;
}

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

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

  await sql`
    INSERT INTO roles (id, name, panel_access)
    VALUES (${ADMIN_ROLE}, 'StatsDailyAdminRole', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO role_squad_permissions (role_id, squad_permission_key)
    VALUES (${ADMIN_ROLE}, 'canseeadminchat')
    ON CONFLICT DO NOTHING
  `;

  for (const [id, name, roleId] of [
    [PLAYER_A, 'StatsAlpha', null],
    [PLAYER_B, 'StatsBravo', null],
    [PLAYER_C, 'StatsCharlie', null],
    [ADMIN_P, 'StatsAdmin', ADMIN_ROLE],
  ] as Array<[string, string, string | null]>) {
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized, role_id, first_seen_at)
      VALUES (${id}, ${name}, ${name.toLowerCase()}, ${roleId}, '2020-01-01T00:00:00Z'::timestamptz)
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const [id, slug] of [
    [SERVER_1, 'stats-srv-1'],
    [SERVER_2, 'stats-srv-2'],
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
  await sql`TRUNCATE server_daily_stats`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM chat_messages WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM combat_events WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM moderation_actions WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM matches WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B, PLAYER_C, ADMIN_P]})`;
  await sql`DELETE FROM role_squad_permissions WHERE role_id = ${ADMIN_ROLE}`;
  await sql`DELETE FROM roles WHERE id = ${ADMIN_ROLE}`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE server_daily_stats`;
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM chat_messages WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM combat_events WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM moderation_actions WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM matches WHERE server_id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`
    UPDATE players SET first_seen_at = '2020-01-01T00:00:00Z'::timestamptz
    WHERE id = ANY(${[PLAYER_A, PLAYER_B, PLAYER_C, ADMIN_P]})
  `;
});

describeIfDb('server_daily_stats table shape', () => {
  it('has the composite (server_id, day) primary key', async () => {
    const [pk] = await sql<{ cols: string }[]>`
      SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'server_daily_stats'::regclass AND i.indisprimary
    `;
    expect(pk.cols).toBe('server_id,day');
  });

  it('indexes day for range scans', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'server_daily_stats'
        AND indexname = 'server_daily_stats_day_idx'
    `;
    expect(rows).toHaveLength(1);
  });

  it('rejects negative counters via the check constraint', async () => {
    await expect(
      sql`INSERT INTO server_daily_stats (server_id, day, matches)
          VALUES (${SERVER_1}, '2026-07-04', -1)`,
    ).rejects.toThrow(/server_daily_stats_nonneg_chk/);
  });

  it('cascades on server deletion', async () => {
    const throwaway = '00000993-0000-4000-8000-000000000000';
    await sql`INSERT INTO servers (id, display_name, slug) VALUES (${throwaway}, 'tmp', 'stats-tmp')`;
    await sql`INSERT INTO server_daily_stats (server_id, day) VALUES (${throwaway}, '2026-07-04')`;
    await sql`DELETE FROM servers WHERE id = ${throwaway}`;
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM server_daily_stats WHERE server_id = ${throwaway}
    `;
    expect(rows[0]?.n).toBe(0);
  });
});

describeIfDb('recomputeServerDailyStats population', () => {
  it('splits a cross-midnight session across both days and derives avg/peak online', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T23:00:00.000Z',
      disconnectedAt: '2026-07-05T01:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const first = await rowFor(SERVER_1, '2026-07-04');
    const second = await rowFor(SERVER_1, '2026-07-05');
    expect(Number(first.online_seconds)).toBe(3600);
    expect(Number(second.online_seconds)).toBe(3600);
    expect(first.peak_online).toBe(1);
    expect(second.peak_online).toBe(1);
  });

  it('computes the exact peak of overlapping sessions, not the session count', async () => {
    // A: 10:00–12:00, B: 11:00–13:00, C: 14:00–15:00 → peak 2, never 3.
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T10:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T11:00:00.000Z',
      disconnectedAt: '2026-07-04T13:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_C,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T14:00:00.000Z',
      disconnectedAt: '2026-07-04T15:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const row = await rowFor(SERVER_1, '2026-07-04');
    expect(row.peak_online).toBe(2);
    expect(Number(row.online_seconds)).toBe(2 * 3600 + 2 * 3600 + 3600);
  });

  it('averages online concurrency over the whole day', async () => {
    // 43 200 online seconds over an 86 400 s day → avg concurrency 0.5 → rounds to 1.
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_C,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const row = await rowFor(SERVER_1, '2026-07-04');
    // 3 players × 12 h = 129 600 s / 86 400 s = 1.5 → 2 (half-up).
    expect(row.avg_online).toBe(2);
    expect(row.peak_online).toBe(3);
  });

  it('keeps queue sessions out of online and reports them as avg_queue', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-05T00:00:00.000Z',
      mode: 'queue',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const row = await rowFor(SERVER_1, '2026-07-04');
    expect(Number(row.online_seconds)).toBe(0);
    expect(row.peak_online).toBe(0);
    expect(row.avg_queue).toBe(1);
  });

  it('scopes population to the day still in progress by the elapsed span', async () => {
    // NOW is 12:00 on 2026-07-10; one player online the whole elapsed half-day → avg 1, not 0.
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-10T00:00:00.000Z',
      disconnectedAt: '2026-07-10T12:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: '2026-07-10', toDay: '2026-07-10', now: NOW });

    const row = await rowFor(SERVER_1, '2026-07-10');
    expect(Number(row.online_seconds)).toBe(43_200);
    expect(row.avg_online).toBe(1);
  });

  it('keeps each server on its own row', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T10:00:00.000Z',
      disconnectedAt: '2026-07-04T11:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_2,
      connectedAt: '2026-07-04T10:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    expect(Number((await rowFor(SERVER_1, '2026-07-04')).online_seconds)).toBe(3600);
    expect(Number((await rowFor(SERVER_2, '2026-07-04')).online_seconds)).toBe(7200);
  });
});

describeIfDb('recomputeServerDailyStats matches', () => {
  beforeEach(async () => {
    await sql`
      INSERT INTO matches (server_id, map, layer, game_mode, is_seed, started_at, duration_seconds)
      VALUES
        (${SERVER_1}, 'Narva',     'Narva_AAS_v1',     'AAS',      false, '2026-07-04T08:00:00Z', 1800),
        (${SERVER_1}, 'Narva',     'Narva_RAAS_v1',    'RAAS',     false, '2026-07-04T09:00:00Z', 2400),
        (${SERVER_1}, 'Gorodok',   'Gorodok_AAS_v1',   'AAS',      false, '2026-07-04T10:00:00Z', 1200),
        (${SERVER_1}, 'Logar',     'Logar_Seed_v1',    'Seed',     true,  '2026-07-04T11:00:00Z', 900),
        (${SERVER_1}, 'Sumari',    'Sumari_Skirm_v1',  'Skirmish', false, '2026-07-04T12:00:00Z', 600),
        (${SERVER_2}, 'Yehorivka', 'Yehorivka_AAS_v1', 'AAS',      false, '2026-07-04T13:00:00Z', 900),
        (${SERVER_1}, 'Narva',     'Narva_AAS_v1',     'AAS',      false, '2026-07-09T08:00:00Z', 1800)
    `;
  });

  it('counts every match of the day, seed and skirmish included', async () => {
    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    expect((await rowFor(SERVER_1, '2026-07-04')).matches).toBe(5);
    expect((await rowFor(SERVER_2, '2026-07-04')).matches).toBe(1);
  });

  it('breaks matches down by game mode', async () => {
    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    expect((await rowFor(SERVER_1, '2026-07-04')).modes).toEqual({
      AAS: 2,
      RAAS: 1,
      Seed: 1,
      Skirmish: 1,
    });
  });

  it('excludes seed and skirmish rounds from the map breakdown', async () => {
    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    expect((await rowFor(SERVER_1, '2026-07-04')).maps).toEqual({ Narva: 2, Gorodok: 1 });
  });

  it('ignores matches outside the recomputed window', async () => {
    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    const rows = await statsRows();
    expect(rows.some((r) => r.day === '2026-07-09')).toBe(false);
  });
});

describeIfDb('recomputeServerDailyStats community and moderation', () => {
  it('counts only log-sourced chat messages', async () => {
    await sql`
      INSERT INTO chat_messages (player_id, server_id, sent_at, scope, message, source)
      VALUES
        (${PLAYER_A}, ${SERVER_1}, '2026-07-04T10:00:00Z', 'all', 'hi', 'log'),
        (${PLAYER_A}, ${SERVER_1}, '2026-07-04T10:01:00Z', 'all', 'hi again', 'log'),
        (${PLAYER_A}, ${SERVER_1}, '2026-07-04T10:02:00Z', 'broadcast', 'panel say', 'panel')
    `;

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    expect((await rowFor(SERVER_1, '2026-07-04')).chat_messages).toBe(2);
  });

  it('counts only teamkill combat events', async () => {
    await sql`
      INSERT INTO combat_events (event_type, server_id, attacker_player_id, victim_player_id, is_teamkill, occurred_at)
      VALUES
        ('death', ${SERVER_1}, ${PLAYER_A}, ${PLAYER_B}, true,  '2026-07-04T10:00:00Z'),
        ('death', ${SERVER_1}, ${PLAYER_A}, ${PLAYER_C}, true,  '2026-07-04T10:05:00Z'),
        ('death', ${SERVER_1}, ${PLAYER_B}, ${PLAYER_A}, false, '2026-07-04T10:10:00Z')
    `;

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    expect((await rowFor(SERVER_1, '2026-07-04')).teamkills).toBe(2);
  });

  it('counts moderation actions per server and day', async () => {
    await sql`
      INSERT INTO moderation_actions (player_id, server_id, action_type, author_system_label, created_at)
      VALUES
        (${PLAYER_A}, ${SERVER_1}, 'kick', 'test-worker', '2026-07-04T10:00:00Z'),
        (${PLAYER_B}, ${SERVER_1}, 'ban',  'test-worker', '2026-07-04T11:00:00Z'),
        (${PLAYER_C}, ${SERVER_2}, 'warn', 'test-worker', '2026-07-05T11:00:00Z')
    `;

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    expect((await rowFor(SERVER_1, '2026-07-04')).punishments).toBe(2);
    expect((await rowFor(SERVER_2, '2026-07-05')).punishments).toBe(1);
    expect((await rowFor(SERVER_1, '2026-07-05')).punishments).toBe(0);
  });

  it('attributes a new player to the server of their first session', async () => {
    await sql`
      UPDATE players SET first_seen_at = '2026-07-04T09:00:00Z'::timestamptz WHERE id = ${PLAYER_A}
    `;
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_2,
      connectedAt: '2026-07-04T09:00:00.000Z',
      disconnectedAt: '2026-07-04T10:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T11:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });
    // PLAYER_B is an existing player who also played that day — must not count as new.
    await seedSession({
      playerId: PLAYER_B,
      serverId: SERVER_2,
      connectedAt: '2026-07-04T09:00:00.000Z',
      disconnectedAt: '2026-07-04T10:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    expect((await rowFor(SERVER_2, '2026-07-04')).new_players).toBe(1);
    expect((await rowFor(SERVER_1, '2026-07-04')).new_players).toBe(0);
  });

  it('derives avg/peak admins from roles carrying squad permissions', async () => {
    await seedSession({
      playerId: ADMIN_P,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-05T00:00:00.000Z',
    });
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T00:00:00.000Z',
      disconnectedAt: '2026-07-05T00:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const row = await rowFor(SERVER_1, '2026-07-04');
    expect(row.peak_online).toBe(2);
    expect(row.peak_admins).toBe(1);
    expect(row.avg_admins).toBe(1);
  });
});

describeIfDb('recomputeServerDailyStats write semantics', () => {
  it('writes one row per server and day in the window', async () => {
    const written = await recomputeServerDailyStats(sql, {
      fromDay: FROM_DAY,
      toDay: TO_DAY,
      now: NOW,
    });
    const rows = await statsRows();
    // Two fixture servers × two days; other suites may leave servers behind, so compare
    // against the reported write count rather than a hard-coded total.
    expect(written).toBe(rows.length);
    expect(rows.filter((r) => r.server_id === SERVER_1).map((r) => r.day)).toEqual([
      FROM_DAY,
      TO_DAY,
    ]);
  });

  it('is idempotent — a second run reproduces identical rows', async () => {
    await seedSession({
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: '2026-07-04T10:00:00.000Z',
      disconnectedAt: '2026-07-04T12:00:00.000Z',
    });

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    const first = await statsRows();
    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });
    const second = await statsRows();

    expect(second).toEqual(first);
  });

  it('leaves days outside the window untouched', async () => {
    await sql`
      INSERT INTO server_daily_stats (server_id, day, matches) VALUES (${SERVER_1}, '2026-06-01', 42)
    `;

    await recomputeServerDailyStats(sql, { fromDay: FROM_DAY, toDay: TO_DAY, now: NOW });

    const rows = await statsRows();
    expect(rows.find((r) => r.day === '2026-06-01')?.matches).toBe(42);
  });

  it('returns 0 and writes nothing for an inverted window', async () => {
    const written = await recomputeServerDailyStats(sql, {
      fromDay: TO_DAY,
      toDay: FROM_DAY,
      now: NOW,
    });
    expect(written).toBe(0);
    expect(await statsRows()).toEqual([]);
  });
});
