import { describe, expect, it } from 'vitest';
import { EXTERNAL_BAN_CACHE_VERSION_KEY } from '../src/external-bans.js';
import * as root from '../src/index.js';

describe('external-ban cache contract', () => {
  it('uses the shared Redis version key consumed by producers and workers', () => {
    expect(EXTERNAL_BAN_CACHE_VERSION_KEY).toBe('external-bans:version');
  });

  it('re-exports the cache version key from the package root', () => {
    expect(root.EXTERNAL_BAN_CACHE_VERSION_KEY).toBe(EXTERNAL_BAN_CACHE_VERSION_KEY);
  });
});
