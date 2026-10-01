/**
 * Wraps a tick so a call that arrives while the previous one is still running
 * is skipped instead of running concurrently.
 *
 * A bare `setInterval(tick, ms)` fires again on schedule even when the last
 * pass is still awaiting a slow query or upstream call, and two overlapping
 * passes can act on the same rows. The in-flight flag is cleared in a
 * `finally`, so a tick that throws does not block later ones; the error still
 * propagates to the caller.
 *
 * @param tick - The pass to guard.
 * @param onSkip - Called when a call is skipped; omit to skip silently.
 * @returns A function with the same contract as `tick` that resolves
 *   immediately when it skips.
 */
export function guardAgainstOverlap(
  tick: () => Promise<void>,
  onSkip?: () => void,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      onSkip?.();
      return;
    }
    inFlight = true;
    try {
      await tick();
    } finally {
      inFlight = false;
    }
  };
}
