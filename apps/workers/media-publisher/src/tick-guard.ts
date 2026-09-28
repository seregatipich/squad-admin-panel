/**
 * Wraps a tick callback so overlapping invocations are skipped instead of
 * running concurrently.
 *
 * Uploads are known to run longer than the poll interval (`index.ts`'s own
 * comment on `TICK_INTERVAL_MS`), so a bare `setInterval(tick, ms)` can still
 * be running a previous call when the next one fires. Each overlapping call
 * would then claim its own `BATCH_SIZE` more rows and hold its own in-memory
 * reads (`youtube.ts`'s `readMedia`, up to 2 GiB), risking unbounded
 * concurrent memory use under a slow destination (#63 finding 943).
 */
export function guardOverlappingTicks(
  tick: () => Promise<void>,
  onSkipped: () => void,
): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      onSkipped();
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
