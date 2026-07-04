import type postgres from 'postgres';
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
