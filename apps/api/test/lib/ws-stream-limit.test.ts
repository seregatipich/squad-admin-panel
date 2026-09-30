import { describe, expect, it } from 'vitest';
import { createStreamLimiter } from '../../src/lib/ws-stream-limit.js';

describe('createStreamLimiter (#1298)', () => {
  it('caps streams per caller', () => {
    const limiter = createStreamLimiter({ perCaller: 2, total: 10 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).toBeNull();
    expect(limiter.acquire('b')).not.toBeNull();
  });

  it('caps streams in total across callers', () => {
    const limiter = createStreamLimiter({ perCaller: 5, total: 2 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('b')).not.toBeNull();
    expect(limiter.acquire('c')).toBeNull();
  });

  it('frees a slot on release, and a second release of it is a no-op', () => {
    const limiter = createStreamLimiter({ perCaller: 1, total: 1 });
    const release = limiter.acquire('a');
    expect(release).not.toBeNull();
    release?.();
    release?.();
    const next = limiter.acquire('b');
    expect(next).not.toBeNull();
    expect(limiter.acquire('a')).toBeNull();
    next?.();
    expect(limiter.acquire('a')).not.toBeNull();
  });
});
