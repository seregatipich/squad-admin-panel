/**
 * Helpers for building SQL `LIKE` / `ILIKE` patterns from user input.
 *
 * Postgres treats `%` and `_` as wildcards and `\` as the default escape
 * character, so raw user text interpolated into `%${q}%` turns a search for
 * `_` or `%` into "match everything". Escaping all three keeps the input
 * literal under the default `ESCAPE '\'`.
 */

/**
 * Escape `\`, `%` and `_` so the value matches literally inside a LIKE pattern.
 *
 * @param value - Raw user-supplied search text.
 * @returns The text with every LIKE metacharacter prefixed by a backslash.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Build a substring ("contains") LIKE pattern from raw user input.
 *
 * @param value - Raw user-supplied search text.
 * @returns `%<escaped value>%`, safe to bind as a LIKE/ILIKE parameter.
 */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}
