/** Postgres SQLSTATE for `unique_violation`. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Maximum depth of the `cause` chain inspected; drizzle wraps driver errors. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Reports whether `err` (or an error in its `cause` chain) is a Postgres
 * unique-constraint violation.
 *
 * Drizzle wraps postgres.js errors, so the SQLSTATE may sit on `err.cause`
 * rather than on `err` itself; the chain is walked up to five levels.
 *
 * @param err - Any thrown value.
 * @param constraint - When given, only a violation of this named constraint
 *   matches, so callers can tell e.g. a slug conflict from a primary-key one.
 * @returns `true` when a matching `23505` error is found.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < MAX_CAUSE_DEPTH;
    depth++
  ) {
    if (typeof current === 'object') {
      const pgError = current as {
        code?: unknown;
        constraint_name?: unknown;
        constraint?: unknown;
      };
      if (pgError.code === PG_UNIQUE_VIOLATION) {
        if (constraint === undefined) return true;
        const name = pgError.constraint_name ?? pgError.constraint;
        if (name === constraint) return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
