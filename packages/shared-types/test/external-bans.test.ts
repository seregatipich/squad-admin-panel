import { describe, expect, it } from 'vitest';
import { banSyncManualPendingKey, EXTERNAL_BAN_CACHE_VERSION_KEY } from '../src/external-bans.js';
import * as root from '../src/index.js';

describe('external-ban cache contract', () => {
  it('uses the shared Redis version key consumed by producers and workers', () => {
    expect(EXTERNAL_BAN_CACHE_VERSION_KEY).toBe('external-bans:version');
  });

  it('re-exports the cache version key from the package root', () => {
    expect(root.EXTERNAL_BAN_CACHE_VERSION_KEY).toBe(EXTERNAL_BAN_CACHE_VERSION_KEY);
  });

  it('keys the manual-sync dedup lock per source under the manual stream', () => {
    expect(banSyncManualPendingKey('src-1')).toMatch(/:pending:src-1$/);
    expect(banSyncManualPendingKey('src-1')).not.toBe(banSyncManualPendingKey('src-2'));
  });
});
