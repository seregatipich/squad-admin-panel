/**
 * Whether a database error is a Postgres unique-constraint violation
 * (SQLSTATE 23505). Drizzle wraps the driver error in `DrizzleQueryError`, so
 * the code may sit on the error itself or a few `cause` links down.
 *
 * @param err - Whatever a query rejected with.
 * @returns True for a unique violation anywhere in the first five links.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
