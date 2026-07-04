import { describe, expect, it } from 'vitest';
import {
  buildRosterResponse,
  collectRosterLookups,
  parseStoredRoster,
  type StoredRoster,
  type StoredRosterEntry,
} from '../src/lib/roster.js';

const LINKED_EOS = 'aaaa0123456789abcdef0123456789ab';
const EOS_ONLY = 'bbbb0123456789abcdef0123456789ab';
const UNKNOWN_EOS = 'cccc0123456789abcdef0123456789ab';
const LINKED_STEAM = '76561198012345678';

function entry(overrides: Partial<StoredRosterEntry>): StoredRosterEntry {
  return {
    rcon_id: 0,
    eos_id: LINKED_EOS,
    steam_id64: LINKED_STEAM,
    name: 'Alpha',
    team_id: 1,
    squad_id: 2,
    is_leader: true,
    role: 'USA_Rifleman_01',
    first_seen_at: '2026-07-05T09:45:00.000Z',
    ...overrides,
  };
}

function storedRoster(entries: StoredRosterEntry[]): StoredRoster {
  return { server_id: 'srv', polled_at: '2026-07-05T10:00:00.000Z', players: entries };
}

describe('parseStoredRoster', () => {
  it('returns null for a missing key', () => {
    expect(parseStoredRoster(null)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseStoredRoster('{not json')).toBeNull();
  });

  it('parses a stored roster payload', () => {
    const parsed = parseStoredRoster(JSON.stringify(storedRoster([entry({})])));
    expect(parsed?.players).toHaveLength(1);
  });
});

describe('collectRosterLookups', () => {
  it('collects EOS ids and only non-null steam ids', () => {
    const { eosIds, steamIds } = collectRosterLookups([
      entry({ eos_id: LINKED_EOS, steam_id64: LINKED_STEAM }),
      entry({ eos_id: EOS_ONLY, steam_id64: null }),
    ]);
    expect(eosIds).toEqual([LINKED_EOS, EOS_ONLY]);
    expect(steamIds).toEqual([BigInt(LINKED_STEAM)]);
  });
});

describe('buildRosterResponse', () => {
  it('returns an empty roster for a null store', () => {
    expect(buildRosterResponse(null, [])).toEqual({ polled_at: null, players: [] });
  });

  it('returns polled_at with an empty player list', () => {
    expect(buildRosterResponse(storedRoster([]), [])).toEqual({
      polled_at: '2026-07-05T10:00:00.000Z',
      players: [],
    });
  });

  it('resolves player_id by EOS and preserves EOS-only entries', () => {
    const stored = storedRoster([
      entry({ eos_id: LINKED_EOS, steam_id64: LINKED_STEAM, name: 'Linked' }),
      entry({ eos_id: EOS_ONLY, steam_id64: null, name: 'EpicOnly', squad_id: null }),
      entry({ eos_id: UNKNOWN_EOS, steam_id64: '76561198099999999', name: 'Stranger' }),
    ]);
    const response = buildRosterResponse(stored, [
      { id: 'player-linked', eosId: LINKED_EOS, steamId64: BigInt(LINKED_STEAM) },
      { id: 'player-eos-only', eosId: EOS_ONLY, steamId64: null },
    ]);

    expect(response.players[0]?.player_id).toBe('player-linked');
    expect(response.players[1]?.player_id).toBe('player-eos-only');
    expect(response.players[1]?.steam_id64).toBeNull();
    expect(response.players[1]?.squad_id).toBeNull();
    expect(response.players[2]?.player_id).toBeNull();
  });

  it('falls back to a steam match when EOS is not linked', () => {
    const stored = storedRoster([entry({ eos_id: UNKNOWN_EOS, steam_id64: LINKED_STEAM })]);
    const response = buildRosterResponse(stored, [
      {
        id: 'by-steam',
        eosId: 'someothereosffffffffffffffffffff',
        steamId64: BigInt(LINKED_STEAM),
      },
    ]);
    expect(response.players[0]?.player_id).toBe('by-steam');
  });
});
