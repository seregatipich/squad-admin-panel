import { sql as drizzleSql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { DatabaseClient } from '../client.js';
import type { ClosedReason, SessionMode } from '../schema/player-sessions.js';

export function sessionDurationSeconds(connectedAt: Date, endAt: Date): number {
  const diffMs = endAt.getTime() - connectedAt.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Math.floor(diffMs / 1000);
}

export function crashCloseAt(now: Date, lastEventAt: Date): Date {
  return now.getTime() <= lastEventAt.getTime() ? now : lastEventAt;
}

export function crashDurationSeconds(connectedAt: Date, now: Date, lastEventAt: Date): number {
  return sessionDurationSeconds(connectedAt, crashCloseAt(now, lastEventAt));
}

export interface OpenPlayerSessionInput {
  playerId: string;
  serverId: string;
  connectedAt: Date;
  mode?: SessionMode;
}

export async function openPlayerSession(
  sql: postgres.Sql,
  input: OpenPlayerSessionInput,
): Promise<boolean> {
  const mode = input.mode ?? 'online';
  const inserted = await sql`
    INSERT INTO player_sessions (player_id, server_id, connected_at, mode)
    SELECT ${input.playerId}, ${input.serverId}, ${input.connectedAt}, ${mode}
    WHERE NOT EXISTS (
      SELECT 1 FROM player_sessions
      WHERE player_id = ${input.playerId}
        AND server_id = ${input.serverId}
        AND disconnected_at IS NULL
    )
    RETURNING id
  `;
  return inserted.length > 0;
}

export interface ClosePlayerSessionInput {
  playerId: string;
  serverId: string;
  disconnectedAt: Date;
  closedReason?: ClosedReason;
}

export async function closePlayerSession(
  sql: postgres.Sql,
  input: ClosePlayerSessionInput,
): Promise<number> {
  const reason = input.closedReason ?? 'disconnect';
  const closed = await sql`
    UPDATE player_sessions
    SET disconnected_at = ${input.disconnectedAt},
        duration_seconds =
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${input.disconnectedAt}::timestamptz - connected_at))))::int,
        closed_reason = ${reason}
    WHERE player_id = ${input.playerId}
      AND server_id = ${input.serverId}
      AND disconnected_at IS NULL
    RETURNING id
  `;
  return closed.length;
}

export interface CloseCrashedSessionsInput {
  serverId: string;
  now: Date;
  lastEventAt: Date;
  closedReason?: ClosedReason;
}

export async function closeCrashedSessions(
  sql: postgres.Sql,
  input: CloseCrashedSessionsInput,
): Promise<number> {
  const reason = input.closedReason ?? 'server_crashed';
  const endAt = crashCloseAt(input.now, input.lastEventAt);
  const closed = await sql`
    UPDATE player_sessions
    SET disconnected_at = ${endAt},
        duration_seconds =
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${endAt}::timestamptz - connected_at))))::int,
        closed_reason = ${reason}
    WHERE server_id = ${input.serverId}
      AND disconnected_at IS NULL
    RETURNING id
  `;
  return closed.length;
}

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
