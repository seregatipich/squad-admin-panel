import { describe, expect, it } from 'vitest';
import {
  buildRosterResponse,
  buildSquadMeta,
  collectRosterLookups,
  parseStoredRoster,
  parseStoredSquads,
  type StoredRoster,
  type StoredRosterEntry,
  type StoredSquadEntry,
  type StoredSquads,
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

function squad(overrides: Partial<StoredSquadEntry>): StoredSquadEntry {
  return {
    team_id: 1,
    team_name: 'United States Army',
    squad_id: 2,
    name: 'INF',
    size: 9,
    locked: false,
    creator_name: 'Alpha',
    creator_eos_id: LINKED_EOS,
    creator_steam_id64: LINKED_STEAM,
    is_command_squad: false,
    ...overrides,
  };
}

function storedSquads(entries: StoredSquadEntry[]): StoredSquads {
  return { server_id: 'srv', polled_at: '2026-07-05T10:00:00.000Z', squads: entries };
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

describe('parseStoredSquads', () => {
  it('returns null for a missing key, malformed JSON, or a payload without squads', () => {
    expect(parseStoredSquads(null)).toBeNull();
    expect(parseStoredSquads('{not json')).toBeNull();
    expect(parseStoredSquads(JSON.stringify({ server_id: 'srv' }))).toBeNull();
  });

  it('parses the worker snapshot', () => {
    const parsed = parseStoredSquads(JSON.stringify(storedSquads([squad({})])));
    expect(parsed?.squads).toHaveLength(1);
  });
});

describe('buildSquadMeta', () => {
  it('returns empty lists without a snapshot', () => {
    expect(buildSquadMeta(null)).toEqual({ teams: [], squads: [] });
  });

  it('names each team once, orders teams by id, and strips the creator identity', () => {
    const meta = buildSquadMeta(
      storedSquads([
        squad({ team_id: 2, team_name: 'Russian Ground Forces', squad_id: 1, name: 'БМП' }),
        squad({ team_id: 1, squad_id: 1, name: 'Command Squad', size: 2, is_command_squad: true }),
        squad({ team_id: 1, squad_id: 2, name: 'INF', locked: true }),
      ]),
    );
    expect(meta.teams).toEqual([
      { team_id: 1, name: 'United States Army' },
      { team_id: 2, name: 'Russian Ground Forces' },
    ]);
    expect(meta.squads).toEqual([
      { team_id: 2, squad_id: 1, name: 'БМП', size: 9, locked: false, is_command_squad: false },
      {
        team_id: 1,
        squad_id: 1,
        name: 'Command Squad',
        size: 2,
        locked: false,
        is_command_squad: true,
      },
      { team_id: 1, squad_id: 2, name: 'INF', size: 9, locked: true, is_command_squad: false },
    ]);
    for (const row of meta.squads) {
      expect(row).not.toHaveProperty('creator_eos_id');
      expect(row).not.toHaveProperty('creator_steam_id64');
    }
  });

  it('skips rows without numeric ids instead of failing the whole roster', () => {
    const broken = storedSquads([
      { ...squad({}), team_id: 'x' as unknown as number },
      squad({ squad_id: 3 }),
    ]);
    expect(buildSquadMeta(broken).squads.map((row) => row.squad_id)).toEqual([3]);
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
    expect(buildRosterResponse(null, [])).toEqual({
      polled_at: null,
      players: [],
      teams: [],
      squads: [],
    });
  });

  it('returns polled_at with an empty player list', () => {
    expect(buildRosterResponse(storedRoster([]), [])).toEqual({
      polled_at: '2026-07-05T10:00:00.000Z',
      players: [],
      teams: [],
      squads: [],
    });
  });

  it('attaches team and squad metadata from the squads snapshot', () => {
    const response = buildRosterResponse(
      storedRoster([entry({})]),
      [],
      storedSquads([squad({ locked: true })]),
    );
    expect(response.teams).toEqual([{ team_id: 1, name: 'United States Army' }]);
    expect(response.squads).toEqual([
      { team_id: 1, squad_id: 2, name: 'INF', size: 9, locked: true, is_command_squad: false },
    ]);
    expect(response.players).toHaveLength(1);
  });

  it('keeps the squad metadata even when the player snapshot is gone', () => {
    // The two keys expire independently; a stale players key must not hide
    // the squads that are still known, and vice versa.
    const response = buildRosterResponse(null, [], storedSquads([squad({})]));
    expect(response.players).toEqual([]);
    expect(response.squads).toHaveLength(1);
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
