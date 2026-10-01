import { guardAgainstOverlap as guardOverlappingTicks } from '@squad/worker-kit';
import { describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Regression for #63 finding 943: index.ts drove tick() from a bare
// setInterval(60s) with no guard against a still-running previous tick.
describe('guardOverlappingTicks', () => {
  it('runs the tick normally when nothing is in flight', async () => {
    const onSkipped = vi.fn();
    const inner = vi.fn().mockResolvedValue(undefined);
    const guarded = guardOverlappingTicks(inner, onSkipped);

    await guarded();

    expect(inner).toHaveBeenCalledTimes(1);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('skips a tick that starts while the previous one is still running', async () => {
    const first = deferred<void>();
    const onSkipped = vi.fn();
    const inner = vi.fn().mockReturnValueOnce(first.promise);
    const guarded = guardOverlappingTicks(inner, onSkipped);

    const firstCall = guarded();
    await guarded(); // fires while `first` is still pending

    expect(inner).toHaveBeenCalledTimes(1);
    expect(onSkipped).toHaveBeenCalledTimes(1);

    first.resolve();
    await firstCall;
  });

  it('allows the next tick once the previous one has settled', async () => {
    const onSkipped = vi.fn();
    const inner = vi.fn().mockResolvedValue(undefined);
    const guarded = guardOverlappingTicks(inner, onSkipped);

    await guarded();
    await guarded();

    expect(inner).toHaveBeenCalledTimes(2);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it('clears the in-flight flag even when the tick throws', async () => {
    const onSkipped = vi.fn();
    const inner = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const guarded = guardOverlappingTicks(inner, onSkipped);

    await expect(guarded()).rejects.toThrow('boom');
    await guarded();

    expect(inner).toHaveBeenCalledTimes(2);
    expect(onSkipped).not.toHaveBeenCalled();
  });
});
