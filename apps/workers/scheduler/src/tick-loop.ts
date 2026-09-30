/** Options for {@link startTickLoop}. */
export interface TickLoopOptions {
  /** One scheduler pass; the next one starts only after it settles. */
  tick: () => Promise<void>;
  /** Pause between the end of one tick and the start of the next, in ms. */
  intervalMs: number;
  /** Receives a failed tick's error; the loop keeps running. */
  onError: (err: Error) => void;
}

/**
 * Runs `tick` every `intervalMs`, never two at once (#999).
 *
 * A plain `setInterval` fired the next tick while a slow one was still
 * running — a scheduled restart waits on `containerStop` for up to two
 * minutes before it records `last_executed_at` — so the task was read as
 * still due and dispatched again. Each tick is instead scheduled with
 * `setTimeout` only after the previous one settles.
 *
 * @returns A stop function; no tick is scheduled after it is called, even
 *   when a tick is in flight at that moment.
 */
export function startTickLoop(opts: TickLoopOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await opts.tick();
      } catch (err) {
        opts.onError(err as Error);
      }
      scheduleNext();
    }, opts.intervalMs);
  };

  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
