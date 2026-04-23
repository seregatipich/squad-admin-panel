import { describe, expect, it } from 'vitest';
import { parseListPlayers } from '../src/parse-list-players.js';

describe('ListPlayers parser', () => {
  it('returns an empty list for an empty server', () => {
    const raw = '----- Active Players -----\n----- Recently Disconnected Players [Max of 15] -----';
    expect(parseListPlayers(raw)).toEqual([]);
  });

  it('parses a single active player with all fields', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 0 | Online IDs: EOS: abcdef0123456789abcdef0123456789 Steam: 76561198012345678 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      rcon_id: 0,
      eos_id: 'abcdef0123456789abcdef0123456789',
      steam_id64: '76561198012345678',
      name: 'Alpha',
      team_id: 1,
      squad_id: 2,
      is_leader: true,
      role: 'USA_Rifleman_01',
    });
  });

  it('handles Squad ID: N/A (no squad assigned)', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 1 | Online IDs: EOS: abcdef0123456789abcdef0123456789 Steam: 76561198087654321 | Name: Bravo | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: INS_Grenadier_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.squad_id).toBeNull();
    expect(parsed[0]?.is_leader).toBe(false);
  });

  it('ignores rows below the disconnected header', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 0 | Online IDs: EOS: abcdef0123456789abcdef0123456789 Steam: 76561198012345678 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01',
      '----- Recently Disconnected Players [Max of 15] -----',
      'ID: 9 | Online IDs: EOS: abcdef0123456789abcdef0123456789 Steam: 76561198011111111 | Since Disconnect: 05m.32s | Name: Gone',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('Alpha');
  });
});
