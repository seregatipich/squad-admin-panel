import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** Largest value of Postgres `bigint`; a longer digit string is no SteamID64. */
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Escapes the LIKE wildcards `%` and `_` (and the escape character itself)
 * so user input is matched literally inside a `%…%` pattern.
 *
 * @param value - Raw search text.
 * @returns The text with `\`, `%` and `_` backslash-escaped.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds an exact SteamID64 match that can use the `steam_id64` btree index.
 *
 * Comparing `steam_id64::text = $1` casts the column and forces a scan of
 * every player row (#40, finding #1328); this compares the column to a
 * `bigint` parameter instead, and only when the query is a digit string that
 * fits in `bigint` — anything else can never equal a SteamID64, so it
 * renders as `false`.
 *
 * @param column - The `steam_id64` column (for a raw SQL alias, pass an
 *   `sql` fragment such as sql`p.steam_id64`).
 * @param query - The trimmed search text.
 * @returns A boolean SQL expression.
 */
export function steamId64Equals(column: AnyPgColumn | SQL, query: string): SQL {
  if (!/^\d{1,19}$/.test(query)) return sql`false`;
  const value = BigInt(query);
  if (value > PG_BIGINT_MAX) return sql`false`;
  return sql`${column} = ${value.toString()}::bigint`;
}
