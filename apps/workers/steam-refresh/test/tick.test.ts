import type { SteamBanInfo, SteamOwnedGames, SteamProfile } from '@squad/steam-api';
import { describe, expect, it, vi } from 'vitest';
import {
  runSteamRefreshTick,
  STEAM_REFRESH_BATCH_SIZE,
  STEAM_REFRESH_STALE_MS,
  type SteamRefreshCandidate,
  type SteamRefreshSnapshot,
  type SteamRefreshTickDeps,
} from '../src/tick.js';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const candidateA: SteamRefreshCandidate = {
  playerId: 'player-a',
  steamId64: 76561198000000001n,
};
const candidateB: SteamRefreshCandidate = {
  playerId: 'player-b',
  steamId64: 76561198000000002n,
};
const candidates = [candidateA, candidateB];

function profile(name: string): SteamProfile {
  return {
    persona: name,
    avatarUrl: `https://cdn.example/${name}.jpg`,
    visibility: 3,
    createdAt: 1_500_000_000,
  };
}

function ban(id: bigint): SteamBanInfo {
  return {
    steamId64: String(id),
    communityBanned: false,
    vacBanned: false,
    vacBanCount: 0,
    gameBanCount: 0,
    daysSinceLastBan: 0,
    economyBan: 'none',
  };
}

function owned(playtimeMinutes: number): SteamOwnedGames {
  return { ownsSquad: true, playtimeMinutes };
}

function deps(overrides: Partial<SteamRefreshTickDeps> = {}): SteamRefreshTickDeps {
  return {
    apiKey: 'test-key',
    now: NOW,
    findCandidates: vi.fn().mockResolvedValue(candidates),
    fetchProfiles: vi.fn().mockResolvedValue(
      new Map([
        [String(candidateA.steamId64), profile('Alpha')],
        [String(candidateB.steamId64), profile('Bravo')],
      ]),
    ),
    fetchBans: vi.fn().mockResolvedValue(
      new Map([
        [String(candidateA.steamId64), ban(candidateA.steamId64)],
        [String(candidateB.steamId64), ban(candidateB.steamId64)],
      ]),
    ),
    fetchOwnedGames: vi.fn().mockResolvedValueOnce(owned(600)).mockResolvedValueOnce(owned(1200)),
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('runSteamRefreshTick', () => {
  it('does not query players or Steam when the API key is absent', async () => {
    const testDeps = deps({ apiKey: '' });

    await expect(runSteamRefreshTick(testDeps)).resolves.toEqual({
      disabled: true,
      selected: 0,
      updated: 0,
      failed: 0,
    });
    expect(testDeps.findCandidates).not.toHaveBeenCalled();
    expect(testDeps.fetchProfiles).not.toHaveBeenCalled();
  });

  it('selects the oldest batch, batches shared reads and persists complete snapshots', async () => {
    const testDeps = deps();

    await expect(runSteamRefreshTick(testDeps)).resolves.toEqual({
      disabled: false,
      selected: 2,
      updated: 2,
      failed: 0,
    });
    expect(testDeps.findCandidates).toHaveBeenCalledWith(
      new Date(NOW.getTime() - STEAM_REFRESH_STALE_MS),
      STEAM_REFRESH_BATCH_SIZE,
    );
    expect(testDeps.fetchProfiles).toHaveBeenCalledOnce();
    expect(testDeps.fetchProfiles).toHaveBeenCalledWith(candidates.map((item) => item.steamId64));
    expect(testDeps.fetchBans).toHaveBeenCalledOnce();
    expect(testDeps.fetchOwnedGames).toHaveBeenCalledTimes(2);
    expect(testDeps.saveSnapshot).toHaveBeenCalledTimes(2);

    const firstSnapshot = vi.mocked(testDeps.saveSnapshot).mock.calls[0]?.[1] as
      | SteamRefreshSnapshot
      | undefined;
    expect(firstSnapshot).toMatchObject({
      personaName: 'Alpha',
      vacBanned: false,
      daysSinceLastBan: null,
      ownsSquad: true,
      steamPlaytimeMinutes: 600,
      steamCheckedAt: NOW,
    });
  });

  it('leaves incomplete players stale so a later tick can retry them', async () => {
    const testDeps = deps({
      fetchOwnedGames: vi.fn().mockResolvedValueOnce(owned(600)).mockResolvedValueOnce(null),
    });

    await expect(runSteamRefreshTick(testDeps)).resolves.toEqual({
      disabled: false,
      selected: 2,
      updated: 1,
      failed: 1,
    });
    expect(testDeps.saveSnapshot).toHaveBeenCalledOnce();
    expect(testDeps.saveSnapshot).toHaveBeenCalledWith('player-a', expect.any(Object));
  });

  it('does not turn an omitted ban response into a false clean record', async () => {
    const testDeps = deps({
      fetchBans: vi
        .fn()
        .mockResolvedValue(new Map([[String(candidateA.steamId64), ban(candidateA.steamId64)]])),
    });

    await expect(runSteamRefreshTick(testDeps)).resolves.toEqual({
      disabled: false,
      selected: 2,
      updated: 1,
      failed: 1,
    });
    expect(testDeps.saveSnapshot).toHaveBeenCalledOnce();
    expect(testDeps.saveSnapshot).toHaveBeenCalledWith('player-a', expect.any(Object));
  });

  it('fails the tick without writes when a shared batch request fails', async () => {
    const testDeps = deps({ fetchProfiles: vi.fn().mockResolvedValue(null) });

    await expect(runSteamRefreshTick(testDeps)).rejects.toThrow('Steam batch request failed');
    expect(testDeps.saveSnapshot).not.toHaveBeenCalled();
    expect(testDeps.diag.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'steam_refresh.run_failed', severity: 'error' }),
    );
  });
});
