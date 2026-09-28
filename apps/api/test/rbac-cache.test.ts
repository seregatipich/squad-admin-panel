import type { DatabaseClient } from '@squad/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateAllPermissionCaches,
  loadUserPermissions,
  PERMISSION_CACHE_MAX_ENTRIES,
  permissionCacheSize,
} from '../src/lib/rbac.js';

// A player with no role: loadUserPermissions caches the empty context without
// any further query, so the cache's own bookkeeping is all that is exercised.
const roleless = { execute: vi.fn().mockResolvedValue([]) } as unknown as DatabaseClient;

afterEach(() => {
  invalidateAllPermissionCaches();
  vi.useRealTimers();
});

describe('permission cache bounds (#66)', () => {
  it('evicts expired entries instead of keeping every player ever seen', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 50; i++) await loadUserPermissions(roleless, `player-${i}`);
    expect(permissionCacheSize()).toBe(50);

    vi.advanceTimersByTime(31_000);
    await loadUserPermissions(roleless, 'player-after-ttl');

    expect(permissionCacheSize()).toBe(1);
  });

  it('never grows past its entry cap', async () => {
    for (let i = 0; i < PERMISSION_CACHE_MAX_ENTRIES + 25; i++) {
      await loadUserPermissions(roleless, `player-${i}`);
    }
    expect(permissionCacheSize()).toBe(PERMISSION_CACHE_MAX_ENTRIES);
  });
});
