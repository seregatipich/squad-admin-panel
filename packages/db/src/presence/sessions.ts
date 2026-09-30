import { sql as drizzleSql } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import type { SessionMode } from '../schema/player-sessions.js';

export type SeedingTransitionKind = 'server.seeding_started' | 'server.seeding_ended';

export interface SplitOpenSessionsAtSeedingTransitionInput {
  serverId: string;
  occurredAt: Date;
  kind: SeedingTransitionKind;
}

/**
 * Atomically closes and reopens connected sessions at a SEED-1 state boundary.
 * A seeding start converts open online/boost sessions to `seed`; a seeding end
 * converts only open `seed` sessions back to `online`. Queue intervals are not
 * connected play and therefore remain untouched.
 *
 * Duplicate transitions are idempotent because rows already in the target mode
 * do not match the source predicate.
 *
 * @param db database client owning the session rows
 * @param input server, durable event timestamp, and transition kind
 * @returns number of sessions moved into the new mode
 */
export async function splitOpenSessionsAtSeedingTransition(
  db: DatabaseClient,
  input: SplitOpenSessionsAtSeedingTransitionInput,
): Promise<number> {
  const startsSeeding = input.kind === 'server.seeding_started';
  const targetMode: SessionMode = startsSeeding ? 'seed' : 'online';
  const occurredAt = input.occurredAt.toISOString();
  const sourceMode = startsSeeding
    ? drizzleSql`mode IN ('online', 'boost')`
    : drizzleSql`mode = 'seed'`;

  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ changed_count: number }>(drizzleSql`
      WITH boundary_updates AS (
        UPDATE player_sessions
        SET mode = ${targetMode}
        WHERE server_id = ${input.serverId}::uuid
          AND disconnected_at IS NULL
          AND connected_at >= ${occurredAt}::timestamptz
          AND ${sourceMode}
        RETURNING id
      ),
      closed AS (
        UPDATE player_sessions
        SET disconnected_at = ${occurredAt}::timestamptz,
            duration_seconds = GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (${occurredAt}::timestamptz - connected_at)))
            )::int
        WHERE server_id = ${input.serverId}::uuid
          AND disconnected_at IS NULL
          AND connected_at < ${occurredAt}::timestamptz
          AND ${sourceMode}
        RETURNING player_id, server_id
      ),
      opened AS (
        INSERT INTO player_sessions (player_id, server_id, connected_at, mode)
        SELECT player_id, server_id, ${occurredAt}::timestamptz, ${targetMode}
        FROM closed
        RETURNING id
      )
      SELECT (
        (SELECT COUNT(*) FROM boundary_updates) + (SELECT COUNT(*) FROM opened)
      )::int AS changed_count
    `);
    return Number(rows[0]?.changed_count ?? 0);
  });
}
