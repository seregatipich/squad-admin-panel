/**
 * Escapes `\`, `%` and `_` so user input matches literally inside a
 * `LIKE`/`ILIKE` pattern. Pair it with `ESCAPE '\'` in the query.
 *
 * @param value - Raw search text.
 * @returns The text with every LIKE metacharacter backslash-escaped.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
