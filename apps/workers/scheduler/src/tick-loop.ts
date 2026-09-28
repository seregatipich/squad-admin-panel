/**
 * Overlap-safe interval loop for the scheduler's `tick()` (#1000, #1015).
 *
 * A plain `setInterval(() => tick(), intervalMs)` can start a second tick
 * while the first is still running — e.g. a scheduled restart's
 * `containerStop` (up to a 60s timeout) outliving the 30s tick interval —
 * which re-dispatches the same due task twice. It also gives a `SIGTERM`
 * handler nothing to wait on before closing the DB/bridge/Redis connections
 * the in-flight tick is still using, which can fail
 * `setLastExecutedAt`/`recordRun`/`writeAuditEntry` mid-write and leave the
 * cursor un-advanced (the same action then repeats once the new container
 * starts).
 *
 * {@link startTickLoop} tracks the current tick's promise, skips an interval
 * fire entirely while one is in flight, and exposes it so shutdown can await
 * it before tearing down connections.
 */
export interface TickLoopController {
  /** Stops scheduling further ticks. Does not cancel an in-flight one. */
  stop(): void;
  /** The in-flight tick's promise, or a resolved one when none is running. */
  waitForCurrentTick(): Promise<void>;
}

export interface TickLoopDeps {
  tick(): Promise<void>;
  intervalMs: number;
  /** Called when an interval fire is skipped because the previous tick is still running. */
  onSkip?: () => void;
  /** Called when `tick()` rejects; the loop keeps running regardless. */
  onError: (err: unknown) => void;
}

export function startTickLoop(deps: TickLoopDeps): TickLoopController {
  let current: Promise<void> | null = null;

  const interval = setInterval(() => {
    if (current) {
      deps.onSkip?.();
      return;
    }
    current = deps
      .tick()
      .catch((err: unknown) => deps.onError(err))
      .finally(() => {
        current = null;
      });
  }, deps.intervalMs);

  return {
    stop: () => clearInterval(interval),
    waitForCurrentTick: () => current ?? Promise.resolve(),
  };
}
