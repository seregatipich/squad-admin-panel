/** Options for {@link startTickLoop}. */
export interface TickLoopOptions {
  /** One scheduler pass; the next one starts only after it settles. */
  tick: () => Promise<void>;
  /** Pause between the end of one tick and the start of the next, in ms. */
  intervalMs: number;
  /** Receives a failed tick's error; the loop keeps running. */
  onError: (err: Error) => void;
}

/** Handle returned by {@link startTickLoop}. */
export interface TickLoopController {
  /** Stops scheduling further ticks. Does not cancel an in-flight one. */
  stop(): void;
  /** The in-flight tick's promise, or a resolved one when none is running. */
  waitForCurrentTick(): Promise<void>;
}

/**
 * Runs `tick` every `intervalMs`, never two at once (#999, #1000, #1015).
 *
 * A plain `setInterval` fired the next tick while a slow one was still
 * running — a scheduled restart waits on `containerStop` for up to two
 * minutes before it records `last_executed_at` — so the task was read as
 * still due and dispatched again. Each tick is instead scheduled with
 * `setTimeout` only after the previous one settles.
 *
 * The in-flight tick is exposed through {@link TickLoopController.waitForCurrentTick}
 * so shutdown can wait for it before closing the DB/bridge/Redis connections
 * it is still using; closing them mid-tick could fail `setLastExecutedAt` or
 * the audit write and repeat the same action once the new container starts.
 *
 * @returns A controller; no tick is scheduled after `stop()` is called, even
 *   when a tick is in flight at that moment.
 */
export function startTickLoop(opts: TickLoopOptions): TickLoopController {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      current = opts
        .tick()
        .catch((err: unknown) => opts.onError(err as Error))
        .finally(() => {
          current = null;
          scheduleNext();
        });
    }, opts.intervalMs);
  };

  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    waitForCurrentTick: () => current ?? Promise.resolve(),
  };
}
