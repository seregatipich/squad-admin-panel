/**
 * A positive integer from the environment, or `undefined` when unset/blank.
 * Mirrors `apps/workers/rcon/src/env.ts`'s `positiveIntEnv` — copy-paste
 * between workers is deliberate (see the architecture note in the repo
 * `CLAUDE.md`), not a shared dependency.
 */
export function positiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A tick interval from the environment: the configured value if it parses as
 * a positive integer, or `fallback` when the variable is unset. An invalid,
 * non-empty value (`'1h'`, `'0'`, a negative number) is a configuration
 * error, not something to silently default away — `Number('1h')` is `NaN`,
 * and passing that straight to `setInterval` used to schedule ticks roughly
 * once a millisecond (#984).
 */
export function requiredTickIntervalMs(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = positiveIntEnv(value);
  if (parsed === undefined) {
    throw new Error(`${name} must be a positive integer of milliseconds, got: ${value}`);
  }
  return parsed;
}
