import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTickLoop } from '../src/tick-loop.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startTickLoop', () => {
  it('skips an interval fire while the previous tick is still in flight (#1015)', async () => {
    let resolveTick: (() => void) | null = null;
    let callCount = 0;
    const onSkip = vi.fn();
    const onError = vi.fn();

    startTickLoop({
      tick: () => {
        callCount++;
        return new Promise<void>((resolve) => {
          resolveTick = resolve;
        });
      },
      intervalMs: 1000,
      onSkip,
      onError,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);

    // The first tick is still pending (a slow containerStop, say); the next
    // two interval fires must be skipped, not start overlapping ticks.
    await vi.advanceTimersByTimeAsync(2000);
    expect(callCount).toBe(1);
    expect(onSkip).toHaveBeenCalledTimes(2);

    resolveTick?.();
    await vi.advanceTimersByTimeAsync(0);

    // Once the first tick settles, the loop resumes on the next fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('waitForCurrentTick resolves only after the in-flight tick settles', async () => {
    let resolveTick: (() => void) | null = null;
    const controller = startTickLoop({
      tick: () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
      intervalMs: 1000,
      onError: () => {},
    });

    await vi.advanceTimersByTimeAsync(1000);

    let settled = false;
    const waited = controller.waitForCurrentTick().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveTick?.();
    await waited;
    expect(settled).toBe(true);
  });

  it('waitForCurrentTick resolves immediately when no tick is running', async () => {
    const controller = startTickLoop({
      tick: async () => {},
      intervalMs: 1000,
      onError: () => {},
    });
    await expect(controller.waitForCurrentTick()).resolves.toBeUndefined();
  });

  it('stop() prevents further ticks from starting', async () => {
    let callCount = 0;
    const controller = startTickLoop({
      tick: async () => {
        callCount++;
      },
      intervalMs: 1000,
      onError: () => {},
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(1);

    controller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(callCount).toBe(1);
  });

  it('routes a rejected tick to onError and keeps the loop alive', async () => {
    let calls = 0;
    const onError = vi.fn();
    startTickLoop({
      tick: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      intervalMs: 1000,
      onError,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
  });
});
