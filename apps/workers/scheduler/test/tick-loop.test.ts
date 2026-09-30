import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTickLoop } from '../src/tick-loop.js';

const INTERVAL_MS = 30_000;

describe('startTickLoop (regression #999)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never starts a tick while the previous one is still running', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tick = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A slow tick, e.g. a scheduled restart waiting on containerStop.
      await new Promise((resolve) => setTimeout(resolve, 2.5 * INTERVAL_MS));
      inFlight -= 1;
    });
    const stop = startTickLoop({ tick, intervalMs: INTERVAL_MS, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    // Two more intervals elapse while the first tick is still running.
    await vi.advanceTimersByTimeAsync(2.5 * INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    // The next tick starts one interval after the slow one settled.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    stop();
  });

  it('keeps ticking after a failed tick and reports the error', async () => {
    const onError = vi.fn();
    const tick = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const stop = startTickLoop({ tick, intervalMs: INTERVAL_MS, onError });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    stop();
  });

  it('stops scheduling once stopped, including after an in-flight tick settles', async () => {
    let finish: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startTickLoop({ tick, intervalMs: INTERVAL_MS, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
