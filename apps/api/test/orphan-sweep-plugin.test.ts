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

beforeEach(async () => {
  vi.useFakeTimers();
  app = Fastify();
  app.decorate('db', {});
  app.decorate('bridge', {});
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

  it('clears timers on close (no lingering intervals)', async () => {
    await app.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanupOrphans).not.toHaveBeenCalled();
  });
});
