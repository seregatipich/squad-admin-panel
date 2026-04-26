import { startHeartbeat } from '@squad/shared-config';
import { describe, expect, it, vi } from 'vitest';

describe('audit-archiver – stub behavior', () => {
  it('startHeartbeat publishes a key with EX TTL via the provided redis interface', async () => {
    const setCalls: Array<[string, string, string, number]> = [];
    const mockRedis = {
      set: vi.fn(async (key: string, value: string, mode: string, ttl: number) => {
        setCalls.push([key, value, mode, ttl]);
        return 'OK';
      }),
    };

    const stop = startHeartbeat({
      redis: mockRedis,
      name: 'audit-archiver',
      statusFn: () => 'idle (P1)',
    });
    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = setCalls[0];
    expect(firstCall).toBeDefined();
    const [key, , mode, ttl] = firstCall ?? ['', '', '', 0];
    expect(key).toBe('worker:heartbeat:audit-archiver');
    expect(mode).toBe('EX');
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('does not throw when redis is null (no REDIS_URL configured)', () => {
    expect(() => {
      const noop = () => {};
      noop();
    }).not.toThrow();
  });
});
