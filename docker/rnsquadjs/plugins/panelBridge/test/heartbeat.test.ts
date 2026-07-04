import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../src/heartbeat.js';

describe('Heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the shared worker-heartbeat JSON payload with 30s TTL', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const hb = new Heartbeat({ set } as never, 'srv-1');
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    hb.stop();
    const [key, raw, ex, ttl] = set.mock.calls[0];
    expect(key).toBe('worker:heartbeat:rnsquadjs:srv-1');
    expect(ex).toBe('EX');
    expect(ttl).toBe(30);
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({ name: 'rnsquadjs:srv-1', status: 'ok' });
    expect(typeof payload.ts).toBe('string');
    expect(typeof payload.pid).toBe('number');
    expect(typeof payload.started_at).toBe('string');
    expect(typeof payload.hostname).toBe('string');
    expect(payload.version).toBe('unknown');
  });

  it('logs and swallows tick rejections instead of producing an unhandled rejection', async () => {
    const set = vi.fn().mockRejectedValue(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hb = new Heartbeat({ set } as never, 'srv-1', 1000);
    hb.start();
    await vi.advanceTimersByTimeAsync(2000);
    hb.stop();
    expect(set).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not fire new ticks after stop()', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const hb = new Heartbeat({ set } as never, 'srv-1', 1000);
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    hb.stop();
    set.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(set).not.toHaveBeenCalled();
  });
});
