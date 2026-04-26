import { describe, expect, it, vi } from 'vitest';
import type { TouchSessionInput } from '../src/lib/sessions.js';
import { touchSession } from '../src/lib/sessions.js';

const fakeRedis = (): TouchSessionInput['redis'] => {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (k: string, _v: string, _ex: string, _ttl: number, mode?: string) => {
      if (mode === 'NX' && store.has(k)) return null;
      store.set(k, _v);
      return 'OK' as const;
    }),
  } as unknown as TouchSessionInput['redis'];
};

describe('touchSession', () => {
  it('updates DB and returns true on first call within window', async () => {
    const redis = fakeRedis();
    const update = vi.fn();
    const did = await touchSession({
      sessionId: 'sid1',
      redis,
      now: new Date('2026-04-25T12:00:00Z'),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    });
    expect(did).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    const firstCall = update.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [newExpiresAt, newLastActivity] = firstCall as [Date, Date];
    expect(newExpiresAt).toEqual(new Date('2026-04-25T18:00:00Z'));
    expect(newLastActivity).toEqual(new Date('2026-04-25T12:00:00Z'));
  });

  it('skips DB update on second call within throttle window', async () => {
    const redis = fakeRedis();
    const update = vi.fn();
    const args = {
      sessionId: 'sid1',
      redis,
      now: new Date(),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    };
    await touchSession(args);
    await touchSession(args);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('different sessions are independent', async () => {
    const redis = fakeRedis();
    const update = vi.fn();
    await touchSession({
      sessionId: 'sid1',
      redis,
      now: new Date(),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    });
    await touchSession({
      sessionId: 'sid2',
      redis,
      now: new Date(),
      ttlSeconds: 21600,
      throttleSeconds: 60,
      updateDb: update,
    });
    expect(update).toHaveBeenCalledTimes(2);
  });
});
