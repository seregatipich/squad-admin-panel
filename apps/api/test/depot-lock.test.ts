import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDepotLock, DEPOT_LOCK_KEY, depotLockStartedAt } from '../src/lib/depot-lock.js';
import { hostRedisUrl } from './integration/isolated-db.js';

// #136: the depot lock must outlive a long update and only ever be released by
// the run that holds it.
const redis = new Redis(hostRedisUrl());

beforeEach(async () => {
  await redis.del(DEPOT_LOCK_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await redis.del(DEPOT_LOCK_KEY);
  await redis.quit();
});

describe('acquireDepotLock', () => {
  it('refuses a second holder while the first holds the lock', async () => {
    const first = await acquireDepotLock(redis);
    expect(first).not.toBeNull();
    expect(await acquireDepotLock(redis)).toBeNull();
    await first?.release();
  });

  it('keeps renewing the lock past its TTL while it is held', async () => {
    const renewals = vi.spyOn(redis, 'eval');
    const lock = await acquireDepotLock(redis, { ttlSeconds: 0.3, renewIntervalMs: 100 });
    // Five renewal rounds span at least 500 ms, well past the 300 ms TTL.
    await vi.waitFor(() => expect(renewals.mock.calls.length).toBeGreaterThanOrEqual(5), {
      timeout: 5_000,
    });
    expect(await redis.exists(DEPOT_LOCK_KEY)).toBe(1);
    expect(await lock?.release()).toBe(true);
    expect(await redis.exists(DEPOT_LOCK_KEY)).toBe(0);
  });

  it('neither releases nor renews a lock another holder took over', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const lock = await acquireDepotLock(redis, { ttlSeconds: 60, renewIntervalMs: 100 });
    await redis.set(DEPOT_LOCK_KEY, 'other-holder', 'EX', 5);
    await vi.advanceTimersByTimeAsync(300);
    // Commands on one connection run in order, so the ping settles after every renewal attempt.
    await redis.ping();

    expect(await redis.pttl(DEPOT_LOCK_KEY)).toBeLessThanOrEqual(5_000);
    expect(await lock?.release()).toBe(false);
    expect(await redis.get(DEPOT_LOCK_KEY)).toBe('other-holder');
  });

  it('stores the start time as the readable prefix of the lock value', async () => {
    const lock = await acquireDepotLock(redis);
    const stored = await redis.get(DEPOT_LOCK_KEY);
    expect(stored).not.toBeNull();
    expect(depotLockStartedAt(stored ?? '')).toBe(lock?.startedAt);
    expect(depotLockStartedAt('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    await lock?.release();
  });
});
