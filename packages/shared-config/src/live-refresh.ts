/**
 * Contracts that make server state reach the panel as soon as it changes
 * instead of on the next timer tick.
 *
 * `RCON_REFRESH_CHANNEL` is a Redis pub/sub channel: any process that learns
 * the roster or the match just changed (log-ingest sees a join, a leave, a new
 * match) publishes a hint on it, and worker-rcon re-polls that one server at
 * once. The worker's own timers stay as the fallback for changes no log line
 * announces (squad joins, tickrate).
 *
 * `EVENTS_APPENDED_PG_CHANNEL` is the Postgres `NOTIFY` channel the `events`
 * insert trigger (migration 0116) signals on, with the row's `server_id` (or
 * an empty string for a global event) as the payload. The API listens and
 * turns it into a `server.events.appended` live-bus frame.
 */
export const RCON_REFRESH_CHANNEL = 'rcon:refresh';

export const EVENTS_APPENDED_PG_CHANNEL = 'events_appended';

/** `roster` re-reads ListPlayers/ListSquads; `info` re-reads ShowServerInfo/ShowNextMap. */
export type RconRefreshScope = 'roster' | 'info';

export interface RconRefreshHint {
  server_id: string;
  scopes: RconRefreshScope[];
  reason?: string;
}

const SCOPES: readonly RconRefreshScope[] = ['roster', 'info'];

export function encodeRconRefreshHint(hint: RconRefreshHint): string {
  return JSON.stringify(hint);
}

/** Parses a hint off the wire; anything malformed is dropped (`null`), never thrown. */
export function parseRconRefreshHint(raw: string): RconRefreshHint | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { server_id, scopes, reason } = value as Record<string, unknown>;
  if (typeof server_id !== 'string' || server_id === '') return null;
  if (!Array.isArray(scopes)) return null;
  const valid = scopes.filter((s): s is RconRefreshScope => SCOPES.includes(s as RconRefreshScope));
  if (valid.length === 0) return null;
  return {
    server_id,
    scopes: Array.from(new Set(valid)),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}

/**
 * Which refresh a log event calls for, or `null` when it does not change what
 * RCON reports. Joins and leaves move the roster; a match boundary moves the
 * map, the next layer and the teams.
 */
export function rconRefreshScopesForEvent(eventType: string): RconRefreshScope[] | null {
  switch (eventType) {
    case 'player.connected':
    case 'player.disconnected':
      return ['roster'];
    case 'match.started':
    case 'match.ended':
      return ['roster', 'info'];
    default:
      return null;
  }
}
