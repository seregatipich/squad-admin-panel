import { describe, expect, it } from 'vitest';
import {
  formatTimeOnServer,
  groupRosterBySquad,
  groupRosterByTeam,
  kitLabel,
  type RosterPlayer,
  type RosterSquadMeta,
  shortEos,
  sortRoster,
  squadLabel,
  teamLabel,
} from './roster-format';

function makePlayer(overrides?: Partial<RosterPlayer>): RosterPlayer {
  return {
    player_id: '00000000-0000-7000-8000-000000000001',
    rcon_id: 0,
    eos_id: 'abcdef0123456789abcdef0123456789',
    steam_id64: '76561198012345678',
    name: 'Alpha',
    team_id: 1,
    squad_id: 2,
    is_leader: false,
    role: 'USA_Rifleman_01',
    first_seen_at: '2026-07-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('formatTimeOnServer', () => {
  const base = new Date('2026-07-05T10:00:00.000Z').getTime();

  it('returns em dash when first_seen_at is missing', () => {
    expect(formatTimeOnServer(null, base)).toBe('—');
  });

  it('returns em dash for an unparseable timestamp', () => {
    expect(formatTimeOnServer('not-a-date', base)).toBe('—');
  });

  it('formats seconds under a minute', () => {
    expect(formatTimeOnServer('2026-07-05T10:00:00.000Z', base + 45_000)).toBe('45с');
  });

  it('formats minutes and padded seconds', () => {
    expect(formatTimeOnServer('2026-07-05T10:00:00.000Z', base + 125_000)).toBe('2м 05с');
  });

  it('formats hours and padded minutes', () => {
    expect(formatTimeOnServer('2026-07-05T10:00:00.000Z', base + 3_900_000)).toBe('1ч 05м');
  });

  it('never returns a negative duration when the clock is behind', () => {
    expect(formatTimeOnServer('2026-07-05T10:00:10.000Z', base)).toBe('0с');
  });
});

describe('shortEos', () => {
  it('truncates a full EOS id', () => {
    expect(shortEos('abcdef0123456789abcdef0123456789')).toBe('abcdef01…6789');
  });

  it('leaves short ids untouched', () => {
    expect(shortEos('abcd')).toBe('abcd');
  });
});

describe('team and squad labels', () => {
  it('renders numeric ids', () => {
    expect(teamLabel(2)).toBe('2');
    expect(squadLabel(3)).toBe('3');
  });

  it('renders em dash for null', () => {
    expect(teamLabel(null)).toBe('—');
    expect(squadLabel(null)).toBe('—');
  });
});

describe('kitLabel', () => {
  it('drops the faction prefix and the variant suffix', () => {
    expect(kitLabel('USA_Rifleman_01')).toBe('Rifleman');
    expect(kitLabel('CAF_SL_01')).toBe('SL');
    expect(kitLabel('INS_Raider_02')).toBe('Raider');
  });

  it('keeps a role without a variant or without a faction readable', () => {
    expect(kitLabel('USA_Recruit')).toBe('Recruit');
    expect(kitLabel('Recruit')).toBe('Recruit');
    expect(kitLabel('MEA_Combat_Engineer_01')).toBe('Combat Engineer');
  });

  it('returns null when the role is unknown', () => {
    expect(kitLabel(null)).toBeNull();
    expect(kitLabel('')).toBeNull();
    expect(kitLabel('___')).toBeNull();
  });
});

describe('sortRoster', () => {
  it('orders by team, then squad, then name; unassigned last', () => {
    const roster = [
      makePlayer({ name: 'Zed', team_id: 2, squad_id: 1 }),
      makePlayer({ name: 'Noone', team_id: null, squad_id: null }),
      makePlayer({ name: 'Bob', team_id: 1, squad_id: 2 }),
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 2 }),
      makePlayer({ name: 'Solo', team_id: 1, squad_id: null }),
    ];
    const sorted = sortRoster(roster).map((player) => player.name);
    expect(sorted).toEqual(['Amy', 'Bob', 'Solo', 'Zed', 'Noone']);
  });

  it('puts the squad leader first in their squad regardless of name', () => {
    const roster = [
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 2, is_leader: false }),
      makePlayer({ name: 'Zed', team_id: 1, squad_id: 2, is_leader: true }),
      makePlayer({ name: 'Bob', team_id: 1, squad_id: 2, is_leader: false }),
      // A leader in another squad must not jump ahead of squad 2.
      makePlayer({ name: 'Ann', team_id: 1, squad_id: 3, is_leader: true }),
    ];
    const sorted = sortRoster(roster).map((player) => player.name);
    expect(sorted).toEqual(['Zed', 'Amy', 'Bob', 'Ann']);
  });

  it('does not mutate the input array', () => {
    const roster = [makePlayer({ name: 'B', team_id: 2 }), makePlayer({ name: 'A', team_id: 1 })];
    const original = roster.map((player) => player.name);
    sortRoster(roster);
    expect(roster.map((player) => player.name)).toEqual(original);
  });
});

describe('groupRosterBySquad', () => {
  it('groups by (team_id, squad_id) and identifies the squad leader', () => {
    const roster = [
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 2, is_leader: true }),
      makePlayer({ name: 'Bob', team_id: 1, squad_id: 2, is_leader: false }),
      makePlayer({ name: 'Zed', team_id: 2, squad_id: 1, is_leader: false }),
    ];
    const groups = groupRosterBySquad(roster);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ team_id: 1, squad_id: 2 });
    expect(groups[0]?.players.map((p) => p.name)).toEqual(['Amy', 'Bob']);
    expect(groups[0]?.leader?.name).toBe('Amy');
    expect(groups[1]).toMatchObject({ team_id: 2, squad_id: 1, leader: null });
  });

  it('does not merge the same squad_id across different teams', () => {
    const roster = [
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 1 }),
      makePlayer({ name: 'Zed', team_id: 2, squad_id: 1 }),
    ];
    const groups = groupRosterBySquad(roster);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.players[0]?.name)).toEqual(['Amy', 'Zed']);
  });

  it('groups unassigned players (squad_id null) per team without a leader', () => {
    const roster = [
      makePlayer({ name: 'Solo', team_id: 1, squad_id: null, is_leader: false }),
      makePlayer({ name: 'Loner', team_id: 1, squad_id: null, is_leader: false }),
    ];
    const groups = groupRosterBySquad(roster);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ team_id: 1, squad_id: null, leader: null, name: null });
    expect(groups[0]?.players).toHaveLength(2);
  });

  it('decorates a group with its snapshot name and lock, matched per team', () => {
    const roster = [
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 1 }),
      makePlayer({ name: 'Zed', team_id: 2, squad_id: 1 }),
      makePlayer({ name: 'New', team_id: 2, squad_id: 7 }),
    ];
    const groups = groupRosterBySquad(roster, [
      squadMeta({ team_id: 1, squad_id: 1, name: 'Command Squad', is_command_squad: true }),
      squadMeta({ team_id: 2, squad_id: 1, name: 'БМП', locked: true }),
    ]);
    expect(groups[0]).toMatchObject({
      name: 'Command Squad',
      locked: false,
      is_command_squad: true,
    });
    expect(groups[1]).toMatchObject({ name: 'БМП', locked: true, is_command_squad: false });
    // Squad 7 was created after the snapshot: it still shows up, just unnamed.
    expect(groups[2]).toMatchObject({ squad_id: 7, name: null, locked: false });
  });
});

function squadMeta(overrides: Partial<RosterSquadMeta>): RosterSquadMeta {
  return {
    team_id: 1,
    squad_id: 1,
    name: 'INF',
    size: 9,
    locked: false,
    is_command_squad: false,
    ...overrides,
  };
}

describe('groupRosterByTeam', () => {
  it('always yields both match teams, in order, even when one is empty', () => {
    const roster = sortRoster([makePlayer({ name: 'Amy', team_id: 2, squad_id: 1 })]);
    const { teams, unaffiliated } = groupRosterByTeam(roster);
    expect(teams.map((team) => team.team_id)).toEqual([1, 2]);
    expect(teams[0]).toMatchObject({ name: null, squads: [], player_count: 0 });
    expect(teams[1]?.player_count).toBe(1);
    expect(unaffiliated).toEqual([]);
  });

  it('names the columns from the teams snapshot and ignores blank names', () => {
    const { teams } = groupRosterByTeam([], {
      teams: [
        { team_id: 1, name: 'United States Army' },
        { team_id: 2, name: '   ' },
      ],
    });
    expect(teams[0]?.name).toBe('United States Army');
    expect(teams[1]?.name).toBeNull();
  });

  it('orders the Command Squad first, then squads by number, unassigned last', () => {
    const roster = sortRoster([
      makePlayer({ name: 'Solo', team_id: 1, squad_id: null }),
      makePlayer({ name: 'Bob', team_id: 1, squad_id: 1 }),
      makePlayer({ name: 'Cmd', team_id: 1, squad_id: 3, is_leader: true }),
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 2 }),
    ]);
    const { teams } = groupRosterByTeam(roster, {
      squads: [
        squadMeta({ team_id: 1, squad_id: 3, name: 'Command Squad', is_command_squad: true }),
      ],
    });
    expect(teams[0]?.squads.map((group) => group.squad_id)).toEqual([3, 1, 2, null]);
    expect(teams[0]?.player_count).toBe(4);
  });

  it('falls back to squad number order when the snapshot is missing', () => {
    const roster = sortRoster([
      makePlayer({ name: 'Bob', team_id: 1, squad_id: 2 }),
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 1 }),
    ]);
    const { teams } = groupRosterByTeam(roster);
    expect(teams[0]?.squads.map((group) => group.squad_id)).toEqual([1, 2]);
  });

  it('keeps players without a team out of both columns', () => {
    const roster = sortRoster([
      makePlayer({ name: 'Ghost', team_id: null, squad_id: null }),
      makePlayer({ name: 'Amy', team_id: 1, squad_id: 1 }),
    ]);
    const { teams, unaffiliated } = groupRosterByTeam(roster);
    expect(teams.map((team) => team.player_count)).toEqual([1, 0]);
    expect(unaffiliated.map((player) => player.name)).toEqual(['Ghost']);
  });

  it('adds a column for an unexpected extra team instead of dropping its players', () => {
    const roster = sortRoster([makePlayer({ name: 'Odd', team_id: 3, squad_id: 1 })]);
    const { teams } = groupRosterByTeam(roster);
    expect(teams.map((team) => team.team_id)).toEqual([1, 2, 3]);
  });
});
