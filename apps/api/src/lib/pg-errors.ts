/**
 * Postgres error-code detection that survives driver wrapping.
 *
 * drizzle-orm wraps the postgres-js error, so the SQLSTATE (`23505`, `23503`,
 * …) can sit on `err.cause` — or deeper, when another layer wraps again —
 * rather than on the thrown object. A flat `err.code === '23505'` check then
 * silently misses it and the route answers 500 instead of its intended 4xx.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

/** Unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';
/** Foreign-key violation. */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** How many `cause` links are followed before giving up. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether `err`, or any error in its `cause` chain, carries SQLSTATE `code`.
 *
 * @param err - Anything thrown by a database call.
 * @param code - The five-character SQLSTATE to look for.
 * @returns `true` when a matching `code` is found within the first
 *   {@link MAX_CAUSE_DEPTH} links of the chain.
 */
export function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether a database error is a Postgres unique-constraint violation
 * (SQLSTATE 23505), on the error itself or a few `cause` links down.
 *
 * @param err - Whatever a query rejected with.
 * @returns True for a unique violation anywhere in the first five links.
 */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, PG_UNIQUE_VIOLATION);
}
