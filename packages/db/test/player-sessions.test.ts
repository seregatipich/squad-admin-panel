import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_SQL = readFileSync(path.resolve(__dirname, '../sql/player-sessions.sql'), 'utf-8');

const PLAYER_A = '000000a1-0000-4000-8000-000000000000';
const PLAYER_B = '000000b2-0000-4000-8000-000000000000';
const SERVER_1 = '00000011-0000-4000-8000-000000000000';
const SERVER_2 = '00000022-0000-4000-8000-000000000000';

let sql: ReturnType<typeof postgres>;

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
    await sql`INSERT INTO player_sessions (player_id, server_id, connected_at)
              VALUES (${PLAYER_A}, ${SERVER_1}, ${new Date('2026-07-05T12:00:00.000Z')})`;
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
