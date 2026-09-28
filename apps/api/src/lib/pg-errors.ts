const MAX_CAUSE_CHAIN_DEPTH = 6;

/**
 * Resolves the constraint a unique violation (SQLSTATE `23505`) broke, or
 * `null` when `err` is not a unique violation.
 *
 * drizzle-orm wraps driver errors: the wrapper carries only a
 * "Failed query: ..." message, while SQLSTATE and `constraint_name` sit on
 * `err.cause`, so the cause chain is walked. For a unique index the
 * constraint name is the index name. Returns `''` for a unique violation that
 * names no constraint.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current; depth += 1) {
    const candidate = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (candidate.code === '23505') return candidate.constraint_name ?? '';
    current = candidate.cause;
  }
  return null;
}
