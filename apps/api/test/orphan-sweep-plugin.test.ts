import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/cleanup-orphans.js', () => ({
  cleanupOrphans: vi.fn().mockResolvedValue({
    removed_configs: [],
    removed_saved: [],
    errors: [],
  }),
}));

vi.mock('../src/lib/auto-prune.js', () => ({
  fireAutoPrune: vi.fn(),
}));

import { fireAutoPrune } from '../src/lib/auto-prune.js';
import { cleanupOrphans } from '../src/lib/cleanup-orphans.js';
import orphanSweepPlugin from '../src/plugins/orphan-sweep.js';

let app: Awaited<ReturnType<typeof Fastify>>;
let ping: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  ping = vi.fn().mockResolvedValue(undefined);
  app = Fastify();
  app.decorate('db', {});
  app.decorate('bridge', { ping });
  await app.register(orphanSweepPlugin);
  await app.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  vi.clearAllMocks();
});

describe('orphan-sweep plugin', () => {
  it('registers without error and closes cleanly', async () => {
    expect(app).toBeDefined();
    await app.close();
  });

  it('fires orphan sweep and docker prune after boot delay', async () => {
    await vi.advanceTimersByTimeAsync(30_001);
    expect(cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(fireAutoPrune).toHaveBeenCalledTimes(1);
  });

  it('does not fire before boot delay', async () => {
    await vi.advanceTimersByTimeAsync(29_000);
    expect(cleanupOrphans).not.toHaveBeenCalled();
    expect(fireAutoPrune).not.toHaveBeenCalled();
  });

  it('fires orphan sweep periodically after boot', async () => {
    await vi.advanceTimersByTimeAsync(30_001);
    vi.mocked(cleanupOrphans).mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(cleanupOrphans).toHaveBeenCalledTimes(1);
  });

  it('fires docker prune again on the daily timer while the bridge answers', async () => {
    await vi.advanceTimersByTimeAsync(30_001);
    vi.mocked(fireAutoPrune).mockClear();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fireAutoPrune).toHaveBeenCalledTimes(1);
  });

  it('skips the periodic docker prune while the bridge is unreachable', async () => {
    ping.mockRejectedValue(new Error('connect ENOENT /run/panel-host-bridge/bridge.sock'));
    const warn = vi.spyOn(app.log, 'warn').mockImplementation(() => undefined);

    await vi.advanceTimersByTimeAsync(30_001);

    expect(fireAutoPrune).not.toHaveBeenCalled();
    expect(cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { err: 'connect ENOENT /run/panel-host-bridge/bridge.sock' },
      'periodic docker prune skipped: bridge unreachable',
    );
  });

  it('resumes the periodic docker prune once the bridge answers again', async () => {
    ping.mockRejectedValueOnce(new Error('connect ENOENT'));
    vi.spyOn(app.log, 'warn').mockImplementation(() => undefined);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(fireAutoPrune).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fireAutoPrune).toHaveBeenCalledTimes(1);
  });

  it('clears timers on close (no lingering intervals)', async () => {
    await app.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });
});
