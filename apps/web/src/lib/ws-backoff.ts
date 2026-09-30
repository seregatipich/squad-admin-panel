const BASE_MS = 1000;
const CAP_MS = 30_000;

/** Exponential reconnect delay: 1 s doubling per attempt, capped at 30 s. */
export function nextBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 0) return BASE_MS;
  const exp = BASE_MS * 2 ** Math.trunc(attempts);
  return Math.min(exp, CAP_MS);
}

/**
 * {@link nextBackoffMs} scaled into its upper half (50%..100%), so operator tabs
 * do not all reconnect in one wave after an API restart.
 *
 * @param attempts Failed attempts so far.
 * @param random Source of a value in [0, 1); injectable for tests.
 */
export function jitteredBackoffMs(attempts: number, random: () => number = Math.random): number {
  return Math.round(nextBackoffMs(attempts) * (0.5 + random() / 2));
}
