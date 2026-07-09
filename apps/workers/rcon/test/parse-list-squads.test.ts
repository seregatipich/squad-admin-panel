import { describe, expect, it } from 'vitest';
import { parseListSquads } from '../src/parse-list-squads.js';

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
});
