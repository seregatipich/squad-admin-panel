import { describe, expect, it } from 'vitest';
import { parseListSquads, parseListSquadsDetailed } from '../src/parse-list-squads.js';

describe('ListSquads parser', () => {
  it('returns an empty list for empty or malformed output', () => {
    expect(parseListSquads('')).toEqual([]);
    expect(parseListSquads('not squad output')).toEqual([]);
  });

  it('parses squads with team context, lock state, size, and creator ids', () => {
    const raw = [
      'Team ID: 1 (United States Army)',
      'ID: 1 | Name: Command Squad | Size: 2 | Locked: True | Creator Name: Командир 🛡️ | Creator Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678',
      'ID: 2 | Name: INF | Size: 9 | Locked: False | Creator Name: Alpha | Creator Online IDs: EOS: 0123456789abcdef0123456789abcdef',
      'Team ID: 2 (Russian Ground Forces)',
      'ID: 3 | Name: БМП | Size: 4 | Locked: True | Creator Name: [BSS] Pelankin | Creator Online IDs: EOS: 11111111111111111111111111111111 steam: 76561198087654321',
    ].join('\n');

    expect(parseListSquads(raw)).toEqual([
      {
        team_id: 1,
        team_name: 'United States Army',
        squad_id: 1,
        name: 'Command Squad',
        size: 2,
        locked: true,
        creator_name: 'Командир 🛡️',
        creator_eos_id: 'abcdef0123456789abcdef0123456789',
        creator_steam_id64: '76561198012345678',
        is_command_squad: true,
      },
      {
        team_id: 1,
        team_name: 'United States Army',
        squad_id: 2,
        name: 'INF',
        size: 9,
        locked: false,
        creator_name: 'Alpha',
        creator_eos_id: '0123456789abcdef0123456789abcdef',
        creator_steam_id64: null,
        is_command_squad: false,
      },
      {
        team_id: 2,
        team_name: 'Russian Ground Forces',
        squad_id: 3,
        name: 'БМП',
        size: 4,
        locked: true,
        creator_name: '[BSS] Pelankin',
        creator_eos_id: '11111111111111111111111111111111',
        creator_steam_id64: '76561198087654321',
        is_command_squad: false,
      },
    ]);
  });

  it('ignores squad rows before the first team header', () => {
    const raw = [
      'ID: 1 | Name: Orphan | Size: 1 | Locked: False | Creator Name: Alpha | Creator Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678',
      'Team ID: 1 (United States Army)',
      'ID: 2 | Name: Командирский отряд | Size: 1 | Locked: False | Creator Name: Bravo | Creator Online IDs: EOS: 0123456789abcdef0123456789abcdef steam: 76561198087654321',
    ].join('\n');

    const parsed = parseListSquads(raw);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('Командирский отряд');
    expect(parsed[0]?.is_command_squad).toBe(true);
  });

  describe('Squad build 25594911 (team header carries Tickets, #126)', () => {
    const EOS = 'abcdef0123456789abcdef0123456789';
    const STEAM = '76561198012345678';
    const squadRow = (id: number, name: string) =>
      `ID: ${id} | Name: ${name} | Size: 8 | Locked: False | Creator Name: Alpha | Creator Online IDs: EOS: ${EOS} steam: ${STEAM}`;

    it('sets the team context from a header with a ticket count', () => {
      const raw = [
        'Team ID: 1 (7th Guards Mountain Air Assault Division) - Tickets: 169',
        squadRow(1, 'Squad 1'),
        'Team ID: 2 (United States Army) - Tickets: 0',
        squadRow(2, 'INF'),
      ].join('\n');
      const parsed = parseListSquads(raw);
      expect(parsed.map((s) => [s.team_id, s.team_name, s.squad_id, s.name])).toEqual([
        [1, '7th Guards Mountain Air Assault Division', 1, 'Squad 1'],
        [2, 'United States Army', 2, 'INF'],
      ]);
      expect(parsed[0]).toMatchObject({
        size: 8,
        locked: false,
        creator_name: 'Alpha',
        creator_eos_id: EOS,
        creator_steam_id64: STEAM,
      });
    });

    it('keeps a team name that itself contains parentheses', () => {
      const raw = [
        'Team ID: 1 (Armed Forces (Ground)) - Tickets: 120',
        squadRow(1, 'Squad 1'),
      ].join('\n');
      expect(parseListSquads(raw)[0]?.team_name).toBe('Armed Forces (Ground)');
    });

    it('still reads the old header without tickets alongside the new one', () => {
      const raw = [
        'Team ID: 1 (United States Army)',
        squadRow(1, 'Old'),
        'Team ID: 2 (Russian Ground Forces) - Tickets: 88',
        squadRow(2, 'New'),
      ].join('\n');
      expect(parseListSquads(raw).map((s) => [s.team_name, s.name])).toEqual([
        ['United States Army', 'Old'],
        ['Russian Ground Forces', 'New'],
      ]);
    });
  });

  describe('parseListSquadsDetailed', () => {
    it('counts no rows for header-only output', () => {
      const raw = 'Team ID: 1 (A) - Tickets: 5\nTeam ID: 2 (B) - Tickets: 6';
      expect(parseListSquadsDetailed(raw)).toEqual({ squads: [], squadRows: 0, unparsedRows: [] });
    });

    it('reports rows when no header could be read', () => {
      const row =
        'ID: 1 | Name: S | Size: 1 | Locked: False | Creator Name: A | Creator Online IDs: EOS: abcdef0123456789abcdef0123456789';
      const result = parseListSquadsDetailed(['Teams: 1 (A)', row].join('\n'));
      expect(result.squads).toEqual([]);
      expect(result.squadRows).toBe(1);
      expect(result.unparsedRows).toEqual([row]);
    });

    it('reports a row of a layout the parser does not know', () => {
      const raw = ['Team ID: 1 (A)', 'ID: 1 | Name: S | Members: 3'].join('\n');
      const result = parseListSquadsDetailed(raw);
      expect(result.squadRows).toBe(1);
      expect(result.unparsedRows).toEqual(['ID: 1 | Name: S | Members: 3']);
    });
  });
});
