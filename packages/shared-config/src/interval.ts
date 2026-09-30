/** Largest delay `setInterval` honours; anything bigger fires every millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Reads a timer interval in milliseconds from an environment value.
 *
 * `Number()` turns a typo (`'60s'`) into `NaN` and an empty string into `0`,
 * and Node's `setInterval` runs both — as well as delays above
 * {@link MAX_TIMER_DELAY_MS} — every millisecond. Any value that is not a
 * finite number in `(0, MAX_TIMER_DELAY_MS]` therefore yields `fallbackMs`.
 *
 * @param raw - The raw environment value, usually `process.env.SOME_INTERVAL_MS`.
 * @param fallbackMs - The interval to use when `raw` is unset or unusable.
 */
export function intervalMsFromEnv(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : fallbackMs;
}
