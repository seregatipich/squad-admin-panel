import { describe, expect, it } from 'vitest';
import {
  formatTimeOnServer,
  groupRosterBySquad,
  type RosterPlayer,
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
    expect(groups[0]).toMatchObject({ team_id: 1, squad_id: null, leader: null });
    expect(groups[0]?.players).toHaveLength(2);
  });
});
