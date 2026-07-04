import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeCrashedSessions,
  closePlayerSession,
  openPlayerSession,
} from '../src/presence/sessions.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_SQL = readFileSync(path.resolve(__dirname, '../sql/player-sessions.sql'), 'utf-8');

const PLAYER_A = '000000a1-0000-4000-8000-000000000000';
const PLAYER_B = '000000b2-0000-4000-8000-000000000000';
const SERVER_1 = '00000011-0000-4000-8000-000000000000';
const SERVER_2 = '00000022-0000-4000-8000-000000000000';

let sql: ReturnType<typeof postgres>;

async function openSessions(serverId: string) {
  return sql`
    SELECT player_id, disconnected_at, duration_seconds, closed_reason, mode
    FROM player_sessions
    WHERE server_id = ${serverId} AND disconnected_at IS NULL
  `;
}

async function allSessions(serverId: string) {
  return sql`
    SELECT player_id, connected_at, disconnected_at, duration_seconds, closed_reason, mode
    FROM player_sessions
    WHERE server_id = ${serverId}
    ORDER BY connected_at
  `;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  await sql.unsafe(SESSIONS_SQL);
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
  await sql`TRUNCATE player_sessions`;
  await sql`DELETE FROM servers WHERE id = ANY(${[SERVER_1, SERVER_2]})`;
  await sql`DELETE FROM players WHERE id = ANY(${[PLAYER_A, PLAYER_B]})`;
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  if (!sql) return;
  await sql`TRUNCATE player_sessions`;
});

describeIfDb('player_sessions table shape', () => {
  it('is monthly RANGE-partitioned on connected_at', async () => {
    const [meta] = await sql`
      SELECT partstrat, pg_get_partkeydef(partrelid) AS keydef
      FROM pg_partitioned_table
      WHERE partrelid = 'player_sessions'::regclass
    `;
    expect(meta.partstrat).toBe('r');
    expect(meta.keydef).toBe('RANGE (connected_at)');
  });

  it('carries the required indexes including the partial-open and BRIN indexes', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'player_sessions'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has('player_sessions_player_connected_idx')).toBe(true);
    expect(byName.has('player_sessions_server_connected_idx')).toBe(true);
    expect(byName.get('player_sessions_open_idx')).toMatch(/WHERE \(disconnected_at IS NULL\)/);
    expect(byName.get('player_sessions_connected_at_brin_idx')).toMatch(/USING brin/);
  });

  it('routes inserts into the connected_at monthly partition', async () => {
    await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: new Date('2026-07-05T12:00:00.000Z'),
    });
    const [row] = await sql`
      SELECT tableoid::regclass::text AS partition FROM player_sessions
    `;
    expect(row.partition).toBe('player_sessions_2026_07');
  });

  it('rejects an unknown closed_reason and mode via check constraints', async () => {
    await expect(
      sql`INSERT INTO player_sessions (player_id, server_id, connected_at, mode)
          VALUES (${PLAYER_A}, ${SERVER_1}, now(), 'spectator')`,
    ).rejects.toThrow(/player_sessions_mode_chk/);
    await expect(
      sql`INSERT INTO player_sessions (player_id, server_id, connected_at, closed_reason)
          VALUES (${PLAYER_A}, ${SERVER_1}, now(), 'timeout')`,
    ).rejects.toThrow(/player_sessions_closed_reason_chk/);
  });
});

describeIfDb('player_sessions projection', () => {
  it('opens a session on connect with mode online and null close columns', async () => {
    const opened = await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: new Date('2026-07-05T12:00:00.000Z'),
    });
    expect(opened).toBe(true);
    const open = await openSessions(SERVER_1);
    expect(open).toHaveLength(1);
    expect(open[0].mode).toBe('online');
    expect(open[0].disconnected_at).toBeNull();
    expect(open[0].duration_seconds).toBeNull();
    expect(open[0].closed_reason).toBeNull();
  });

  it('does not open a second open session for a duplicate connect (idempotent)', async () => {
    const connectedAt = new Date('2026-07-05T12:00:00.000Z');
    const first = await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt,
    });
    const second = await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: new Date('2026-07-05T12:00:05.000Z'),
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await openSessions(SERVER_1)).toHaveLength(1);
  });

  it('closes the open session on disconnect with a floored duration', async () => {
    const connectedAt = new Date('2026-07-05T12:00:00.000Z');
    await openPlayerSession(sql, { playerId: PLAYER_A, serverId: SERVER_1, connectedAt });
    const closed = await closePlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      disconnectedAt: new Date('2026-07-05T13:00:00.000Z'),
    });
    expect(closed).toBe(1);
    const [row] = await allSessions(SERVER_1);
    expect(row.duration_seconds).toBe(3600);
    expect(row.closed_reason).toBe('disconnect');
    expect(await openSessions(SERVER_1)).toHaveLength(0);
  });

  it('is a no-op when disconnect arrives without an open session', async () => {
    const closed = await closePlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      disconnectedAt: new Date('2026-07-05T13:00:00.000Z'),
    });
    expect(closed).toBe(0);
  });

  it('closes an open session as server_crashed with min(now, last_event) duration', async () => {
    const connectedAt = new Date('2026-07-05T12:00:00.000Z');
    await openPlayerSession(sql, { playerId: PLAYER_A, serverId: SERVER_1, connectedAt });
    const closed = await closeCrashedSessions(sql, {
      serverId: SERVER_1,
      now: new Date('2026-07-05T14:00:00.000Z'),
      lastEventAt: new Date('2026-07-05T13:30:00.000Z'),
    });
    expect(closed).toBe(1);
    const [row] = await allSessions(SERVER_1);
    expect(row.closed_reason).toBe('server_crashed');
    expect(new Date(row.disconnected_at).toISOString()).toBe('2026-07-05T13:30:00.000Z');
    expect(row.duration_seconds).toBe(5400);
    expect(await openSessions(SERVER_1)).toHaveLength(0);
  });

  it('closes every open session of a crashed server but leaves other servers untouched', async () => {
    const connectedAt = new Date('2026-07-05T12:00:00.000Z');
    await openPlayerSession(sql, { playerId: PLAYER_A, serverId: SERVER_1, connectedAt });
    await openPlayerSession(sql, { playerId: PLAYER_B, serverId: SERVER_1, connectedAt });
    await openPlayerSession(sql, { playerId: PLAYER_A, serverId: SERVER_2, connectedAt });
    const closed = await closeCrashedSessions(sql, {
      serverId: SERVER_1,
      now: new Date('2026-07-05T12:20:00.000Z'),
      lastEventAt: new Date('2026-07-05T12:10:00.000Z'),
    });
    expect(closed).toBe(2);
    expect(await openSessions(SERVER_1)).toHaveLength(0);
    expect(await openSessions(SERVER_2)).toHaveLength(1);
  });

  it('lets a fresh connect reopen a session after a crash closed the previous one', async () => {
    await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: new Date('2026-07-05T12:00:00.000Z'),
    });
    await closeCrashedSessions(sql, {
      serverId: SERVER_1,
      now: new Date('2026-07-05T12:10:00.000Z'),
      lastEventAt: new Date('2026-07-05T12:10:00.000Z'),
    });
    const reopened = await openPlayerSession(sql, {
      playerId: PLAYER_A,
      serverId: SERVER_1,
      connectedAt: new Date('2026-07-05T12:30:00.000Z'),
    });
    expect(reopened).toBe(true);
    expect(await openSessions(SERVER_1)).toHaveLength(1);
    expect(await allSessions(SERVER_1)).toHaveLength(2);
  });
});
