import { playerNameHistory, players } from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * SQL predicate: `column` holds the id of a player whose current name or any
 * name in their history contains `query` — the one nickname search the chat
 * archive, event journal, votes and combat-event routes share.
 *
 * The query goes through `normalizePlayerName`, exactly like the stored
 * `canonical_name_normalized`/`name_normalized` columns, so a search typed
 * with a clan tag or doubled spaces (`[TAG]  Nick`) still matches (audit
 * #118/#138).
 *
 * The matching ids stay in a subquery instead of being loaded into Node and
 * bound one parameter per id: a short query on a large database used to
 * exceed Postgres' 65 535 bind-parameter limit and answer 500 (audit
 * #117/#118/#138). The substring `LIKE` is served by the `gin_trgm_ops`
 * indexes on both columns (migration `0119_player_name_trgm_indexes`) for
 * queries of three or more characters.
 *
 * @param column - The player-id column to filter (e.g. `chatMessages.playerId`); a
 *   `text` column such as `events.actor_id` is compared with the ids cast to text.
 * @param query - The raw search text from the request.
 * @returns The predicate, or `null` when the query is blank after normalisation.
 */
export function playerNameMatch(column: AnyPgColumn, query: string): SQL | null {
  const normalized = normalizePlayerName(query);
  if (normalized.length === 0) return null;
  const pattern = `%${escapeLike(normalized)}%`;
  const asText = column.getSQLType() !== 'uuid';
  const playerId = asText ? sql`${players.id}::text` : sql`${players.id}`;
  const historyPlayerId = asText
    ? sql`${playerNameHistory.playerId}::text`
    : sql`${playerNameHistory.playerId}`;
  return sql`${column} IN (
    SELECT ${playerId} FROM ${players}
    WHERE ${players.canonicalNameNormalized} LIKE ${pattern}
    UNION
    SELECT ${historyPlayerId} FROM ${playerNameHistory}
    WHERE ${playerNameHistory.nameNormalized} LIKE ${pattern}
  )`;
}
