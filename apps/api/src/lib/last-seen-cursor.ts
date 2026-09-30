/**
 * Keyset cursor for player lists ordered by `(players.last_seen_at, players.id)`.
 *
 * Wire format: `<last_seen_at µs since epoch>_<player id>`.
 *
 * Microseconds, not `Date.getTime()` milliseconds: `last_seen_at` is a
 * microsecond `timestamptz` (often `DEFAULT now()`), and a millisecond key made
 * ascending pages repeat the cursor row and descending pages skip rows sharing
 * its millisecond (#352).
 */

/** A decoded cursor: the last row's `last_seen_at` in integer µs and its player id. */
export interface LastSeenCursor {
  lastSeenMicros: string;
  id: string;
}

/** Year 9999 in µs since the epoch: a bound no real `last_seen_at` reaches, far inside Postgres' `timestamptz` range. */
const MAX_CURSOR_MICROS = 253_402_300_799_999_999n;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serializes the last row of a page into the opaque cursor handed to the client. */
export function encodeLastSeenCursor(row: LastSeenCursor): string {
  return `${row.lastSeenMicros}_${row.id}`;
}

/**
 * Parses a client-supplied cursor.
 *
 * @returns the decoded cursor, or `null` when it is malformed or out of range
 * (a value past the bound would overflow bigint or `timestamptz` in Postgres
 * and answer 500 instead of 400, #353).
 */
export function parseLastSeenCursor(raw: string): LastSeenCursor | null {
  const sep = raw.indexOf('_');
  if (sep === -1) return null;
  const lastSeenMicros = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!/^-?\d{1,19}$/.test(lastSeenMicros) || !UUID_RE.test(id)) return null;
  const micros = BigInt(lastSeenMicros);
  if (micros > MAX_CURSOR_MICROS || micros < -MAX_CURSOR_MICROS) return null;
  return { lastSeenMicros, id };
}
