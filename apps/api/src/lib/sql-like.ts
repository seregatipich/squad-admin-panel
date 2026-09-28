/**
 * Escapes the `LIKE`/`ILIKE` metacharacters `%`, `_` and the escape character
 * `\` itself, so user input embedded in a `'%…%'` pattern only ever matches
 * literally. Relies on Postgres's default `LIKE` escape character, `\`.
 *
 * @param value - Raw user input.
 * @returns `value` with every metacharacter prefixed by `\`.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
