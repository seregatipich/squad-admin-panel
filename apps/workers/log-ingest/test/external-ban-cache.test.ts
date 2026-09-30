import { EXTERNAL_BAN_CACHE_VERSION_KEY } from '@squad/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalBanCache } from '../src/external-ban/cache.js';

function fakeDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  return { select: vi.fn().mockReturnValue({ from }) };
}

describe('ExternalBanCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('indexes active external bans by SteamID64 and EOS ID', async () => {
    const db = fakeDb([
      {
        externalBanId: '00000000-0000-7000-8000-000000000001',
        sourceId: '00000000-0000-7000-8000-000000000002',
        sourceName: 'Trusted list',
        trustLevel: 'trusted',
        onMatch: 'kick',
        steamId64: '76561198000000000',
        eosId: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
        nickname: 'Cheater',
        reason: 'reason',
      },
    ]);
    const redis = { get: vi.fn().mockResolvedValue('1') };
    const cache = new ExternalBanCache(db as never, redis);

    await expect(cache.match('76561198000000000', null)).resolves.toHaveLength(1);
    await expect(
      cache.match('76561198000000001', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'),
    ).resolves.toHaveLength(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('refreshes after CBAN-2 changes the shared version key', async () => {
    const db = fakeDb([]);
    const getVersion = vi.fn().mockResolvedValueOnce('1').mockResolvedValueOnce('2');
    const cache = new ExternalBanCache(db as never, { get: getVersion });

    await cache.match('76561198000000000', null);
    await cache.match('76561198000000000', null);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(getVersion).toHaveBeenNthCalledWith(1, EXTERNAL_BAN_CACHE_VERSION_KEY);
    expect(getVersion).toHaveBeenNthCalledWith(2, EXTERNAL_BAN_CACHE_VERSION_KEY);
  });

  it('shares one refresh between concurrent matches after a version change', async () => {
    const db = fakeDb([]);
    const cache = new ExternalBanCache(db as never, { get: vi.fn().mockResolvedValue('1') });

    await Promise.all([
      cache.match('76561198000000000', null),
      cache.match('76561198000000001', null),
      cache.match('76561198000000002', null),
    ]);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded index instead of reloading when Redis is unavailable', async () => {
    const db = fakeDb([]);
    const get = vi.fn().mockResolvedValueOnce('1').mockRejectedValue(new Error('redis down'));
    const cache = new ExternalBanCache(db as never, { get });

    await cache.match('76561198000000000', null);
    await cache.match('76561198000000000', null);
    await cache.match('76561198000000000', null);

    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
