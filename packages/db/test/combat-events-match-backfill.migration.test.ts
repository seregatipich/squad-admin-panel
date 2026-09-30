import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 0138 (issue #50, finding 1073): historical combat_events rows get
 * the match they happened in, resolved like log-ingest's resolveMatchId. The
 * migration is re-run here against rows left NULL, which also proves it is
 * idempotent.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL_SQL = readFileSync(
  path.resolve(__dirname, '../drizzle/0138_combat_events_match_uuid_backfill.sql'),
  'utf-8',
);

const SERVER = '00000137-0000-4000-8000-000000000001';
const OTHER_SERVER = '00000137-0000-4000-8000-000000000002';
const VICTIM = '00000137-0000-4000-9000-000000000001';
const FIRST_MATCH = '00000137-0000-4000-a000-000000000001';
const SECOND_MATCH = '00000137-0000-4000-a000-000000000002';
const OTHER_SERVER_MATCH = '00000137-0000-4000-a000-000000000003';

let sql: postgres.Sql;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
  await cleanup();
  for (const [id, slug] of [
    [SERVER, 'backfill-1'],
    [OTHER_SERVER, 'backfill-2'],
  ] as const) {
    await sql`INSERT INTO servers (id, display_name, slug) VALUES (${id}, ${slug}, ${slug})`;
  }
  await sql`
    INSERT INTO players (id, canonical_name, canonical_name_normalized)
    VALUES (${VICTIM}, 'BackfillVictim', 'backfillvictim')`;
  await sql`
    INSERT INTO matches (id, server_id, started_at, ended_at) VALUES
      (${FIRST_MATCH}, ${SERVER}, '2026-01-10T10:00:00Z', '2026-01-10T11:00:00Z'),
      (${SECOND_MATCH}, ${SERVER}, '2026-01-10T11:00:00Z', NULL),
      (${OTHER_SERVER_MATCH}, ${OTHER_SERVER}, '2026-01-10T09:00:00Z', NULL)`;
});

afterAll(async () => {
  if (!sql) return;
  await cleanup();
  await sql.end({ timeout: 5 });
});

async function cleanup(): Promise<void> {
  await sql`DELETE FROM combat_events WHERE server_id IN (${SERVER}, ${OTHER_SERVER})`;
  await sql`DELETE FROM matches WHERE server_id IN (${SERVER}, ${OTHER_SERVER})`;
  await sql`DELETE FROM servers WHERE id IN (${SERVER}, ${OTHER_SERVER})`;
  await sql`DELETE FROM players WHERE id = ${VICTIM}`;
}

async function insertEvent(serverId: string, occurredAt: string): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO combat_events (event_type, server_id, victim_player_id, occurred_at)
    VALUES ('death', ${serverId}, ${VICTIM}, ${occurredAt})
    RETURNING id::text AS id`;
  return Number((row as { id: string }).id);
}

async function matchOf(eventId: number): Promise<string | null> {
  const [row] = await sql<{ match_uuid: string | null }[]>`
    SELECT match_uuid FROM combat_events WHERE id = ${eventId}`;
  return row?.match_uuid ?? null;
}

describeIfDb('migration 0138 combat_events.match_uuid backfill', () => {
  it('links old events to the match of their server that covers them, and leaves the rest NULL', async () => {
    const inFirst = await insertEvent(SERVER, '2026-01-10T10:30:00Z');
    const inOpenSecond = await insertEvent(SERVER, '2026-01-10T12:00:00Z');
    const beforeAnyMatch = await insertEvent(SERVER, '2026-01-10T08:00:00Z');
    const otherServer = await insertEvent(OTHER_SERVER, '2026-01-10T10:30:00Z');
    const alreadyLinked = await insertEvent(SERVER, '2026-01-10T10:45:00Z');
    await sql`UPDATE combat_events SET match_uuid = ${SECOND_MATCH} WHERE id = ${alreadyLinked}`;

    await sql.unsafe(BACKFILL_SQL);

    expect(await matchOf(inFirst)).toBe(FIRST_MATCH);
    expect(await matchOf(inOpenSecond)).toBe(SECOND_MATCH);
    expect(await matchOf(beforeAnyMatch)).toBeNull();
    expect(await matchOf(otherServer)).toBe(OTHER_SERVER_MATCH);
    expect(await matchOf(alreadyLinked)).toBe(SECOND_MATCH);
  });

  it('is idempotent and never touches the legacy bigint match_id', async () => {
    const eventId = await insertEvent(SERVER, '2026-01-10T10:20:00Z');
    await sql.unsafe(BACKFILL_SQL);
    await sql.unsafe(BACKFILL_SQL);

    expect(await matchOf(eventId)).toBe(FIRST_MATCH);
    const [row] = await sql<{ match_id: string | null }[]>`
      SELECT match_id::text AS match_id FROM combat_events WHERE id = ${eventId}`;
    expect(row?.match_id).toBeNull();
  });
});
