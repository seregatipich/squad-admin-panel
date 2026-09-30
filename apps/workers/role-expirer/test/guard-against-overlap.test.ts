import { describe, expect, it } from 'vitest';
import { guardAgainstOverlap } from '../src/index.js';

describe('guardAgainstOverlap (#984)', () => {
  it('skips a call that arrives while the previous one is still running', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;
    let release: (() => void) | undefined;
    const slow = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    const guarded = guardAgainstOverlap(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await slow();
      completed += 1;
      concurrent -= 1;
    });

    const first = guarded();
    // Fires while `first` is still awaiting — this is what a `setInterval`
    // does when a tick outlasts its own period, or when `1h`/`0` collapses
    // the interval to ~1ms (see env.test.ts).
    const second = guarded();
    release?.();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(completed).toBe(1);
  });

  it('runs again once the previous call has finished', async () => {
    let calls = 0;
    const guarded = guardAgainstOverlap(async () => {
      calls += 1;
    });

    await guarded();
    await guarded();

    expect(calls).toBe(2);
  });

  it('clears the in-flight flag even when the tick throws', async () => {
    const guarded = guardAgainstOverlap(async () => {
      throw new Error('boom');
    });

    await expect(guarded()).rejects.toThrow('boom');
    let ran = false;
    await guardAgainstOverlap(async () => {
      ran = true;
    })();
    expect(ran).toBe(true);
  });
});
