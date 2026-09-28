/**
 * Escapes `%`, `_`, and the escape character itself in a value that will be
 * substituted into a Postgres `LIKE`/`ILIKE` pattern (typically wrapped in
 * `%...%` by the caller), so the value is matched literally.
 *
 * Without this, a nickname containing `_` — common in Squad clan tags — acts
 * as a "match any character" wildcard and a substring search becomes far
 * broader than the caller intended (finding #358). Callers pass `ESCAPE
 * '\'` alongside the resulting pattern (Postgres's LIKE default escape
 * character is already `\`, but declaring it explicitly documents intent
 * and stays correct if that default is ever overridden).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
