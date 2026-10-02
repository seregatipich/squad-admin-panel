import { describe, expect, it } from 'vitest';
import { parseListPlayers, parseListPlayersDetailed } from '../src/parse-list-players.js';

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

  it('parses an EOS-only player (no linked Steam account)', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 3 | Online IDs: EOS: 0123456789abcdef0123456789abcdef | Name: EpicOnly | Team ID: 2 | Squad ID: 1 | Is Leader: False | Role: RGF_Rifleman_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      rcon_id: 3,
      eos_id: '0123456789abcdef0123456789abcdef',
      steam_id64: null,
      name: 'EpicOnly',
      team_id: 2,
      squad_id: 1,
      is_leader: false,
      role: 'RGF_Rifleman_01',
    });
  });

  it('keeps EOS-only players alongside fully-linked players', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 0 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198012345678 | Name: Alpha | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01',
      'ID: 1 | Online IDs: EOS: 0123456789abcdef0123456789abcdef | Name: EpicOnly | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: RGF_Rifleman_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.steam_id64).toBe('76561198012345678');
    expect(parsed[1]?.steam_id64).toBeNull();
    expect(parsed[1]?.squad_id).toBeNull();
  });

  it('parses lowercase steam token and normalises EOS to lowercase', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 5 | Online IDs: EOS: ABCDEF0123456789ABCDEF0123456789 steam: 76561198055555555 | Name: MixedCase | Team ID: 1 | Squad ID: 3 | Is Leader: False | Role: USA_Medic_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed[0]?.eos_id).toBe('abcdef0123456789abcdef0123456789');
    expect(parsed[0]?.steam_id64).toBe('76561198055555555');
  });

  it('treats Team ID: N/A as null', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 7 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198077777777 | Name: Unassigned | Team ID: N/A | Squad ID: N/A | Is Leader: False | Role: Unarmed',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed[0]?.team_id).toBeNull();
    expect(parsed[0]?.squad_id).toBeNull();
  });

  it('parses names that contain a pipe character', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 8 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198088888888 | Name: [TAG] Nick | Alt | Team ID: 1 | Squad ID: 1 | Is Leader: True | Role: USA_SL_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');
    const parsed = parseListPlayers(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('[TAG] Nick | Alt');
    expect(parsed[0]?.role).toBe('USA_SL_01');
  });

  it('keeps Cyrillic and emoji nicknames from real server-style output', () => {
    const raw = [
      '----- Active Players -----',
      'ID: 12 | Online IDs: EOS: abcdef0123456789abcdef0123456789 steam: 76561198123456789 | Name: [BSS] Пеланкин 🛠️ | Team ID: 1 | Squad ID: 5 | Is Leader: False | Role: RGF_Medic_01',
      'ID: 13 | Online IDs: EOS: 0123456789abcdef0123456789abcdef steam: 76561198987654321 | Name: КУНГФУ ПАДЛА | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: IMF_Rifleman_01',
      '----- Recently Disconnected Players [Max of 15] -----',
    ].join('\n');

    const parsed = parseListPlayers(raw);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.name).toBe('[BSS] Пеланкин 🛠️');
    expect(parsed[1]?.name).toBe('КУНГФУ ПАДЛА');
  });

  describe('Squad build 25594911 (Party ID and Vehicle fields, #126)', () => {
    const EOS = 'abcdef0123456789abcdef0123456789';
    const STEAM = '76561198012345678';
    const header = '----- Active Players -----';
    const footer = '----- Recently Disconnected Players [Max of 15] -----';

    it('parses a row with Party ID: N/A and Vehicle: N/A', () => {
      const raw = [
        header,
        `ID: 60 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name:  -quic | Team ID: 2 | Party ID: N/A | Squad ID: 1 | Is Leader: False | Role: USA_Medic_02 | Vehicle: N/A`,
        footer,
      ].join('\n');
      expect(parseListPlayers(raw)).toEqual([
        {
          rcon_id: 60,
          eos_id: EOS,
          steam_id64: STEAM,
          name: '-quic',
          team_id: 2,
          squad_id: 1,
          is_leader: false,
          role: 'USA_Medic_02',
        },
      ]);
    });

    it('parses a row with a numbered party, a leader and a vehicle name', () => {
      const raw = [
        header,
        `ID: 95 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name:   3bank0 | Team ID: 2 | Party ID: #0 | Squad ID: 12 | Is Leader: True | Role: RGF_SL_01 | Vehicle: RGF_BTR80_Woodland`,
        footer,
      ].join('\n');
      const [player] = parseListPlayers(raw);
      expect(player).toMatchObject({
        rcon_id: 95,
        name: '3bank0',
        team_id: 2,
        squad_id: 12,
        is_leader: true,
        role: 'RGF_SL_01',
      });
    });

    it('keeps names with a pipe and Cyrillic names under the new layout', () => {
      const raw = [
        header,
        `ID: 8 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: [TAG] Nick | Alt | Team ID: 1 | Party ID: N/A | Squad ID: 1 | Is Leader: True | Role: USA_SL_01 | Vehicle: N/A`,
        `ID: 13 | Online IDs: EOS: 0123456789abcdef0123456789abcdef | Name: КУНГФУ ПАДЛА | Team ID: 2 | Party ID: #3 | Squad ID: N/A | Is Leader: False | Role: IMF_Rifleman_01 | Vehicle: N/A`,
        footer,
      ].join('\n');
      const parsed = parseListPlayers(raw);
      expect(parsed.map((p) => p.name)).toEqual(['[TAG] Nick | Alt', 'КУНГФУ ПАДЛА']);
      expect(parsed[1]?.squad_id).toBeNull();
      expect(parsed[1]?.steam_id64).toBeNull();
    });

    it('reads old-format and new-format rows of one reply together', () => {
      const raw = [
        header,
        `ID: 0 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: Old | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01`,
        `ID: 1 | Online IDs: EOS: 0123456789abcdef0123456789abcdef | Name: New | Team ID: 1 | Party ID: N/A | Squad ID: 2 | Is Leader: False | Role: USA_Rifleman_01 | Vehicle: N/A`,
        footer,
      ].join('\n');
      expect(parseListPlayers(raw).map((p) => p.name)).toEqual(['Old', 'New']);
    });
  });

  describe('parseListPlayersDetailed', () => {
    const header = '----- Active Players -----';
    const footer = '----- Recently Disconnected Players [Max of 15] -----';

    it('counts no rows for an empty server', () => {
      expect(parseListPlayersDetailed([header, footer].join('\n'))).toEqual({
        players: [],
        activeRows: 0,
        unparsedRows: [],
      });
    });

    it('reports rows no layout matched instead of hiding them', () => {
      const raw = [
        header,
        'ID: 1 | Online IDs: EOS: abcdef0123456789abcdef0123456789 | Name: A | Squad: 3 | Role: X',
        'ID: 2 | Online IDs: EOS: 0123456789abcdef0123456789abcdef | Name: B | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: R',
        footer,
        'ID: 9 | Since Disconnect: 05m.32s',
      ].join('\n');
      const result = parseListPlayersDetailed(raw);
      expect(result.activeRows).toBe(2);
      expect(result.players.map((p) => p.name)).toEqual(['B']);
      expect(result.unparsedRows).toEqual([
        'ID: 1 | Online IDs: EOS: abcdef0123456789abcdef0123456789 | Name: A | Squad: 3 | Role: X',
      ]);
    });

    it('reports an active row without an EOS id as unparsed', () => {
      const raw = [
        header,
        'ID: 4 | Online IDs: steam: 76561198012345678 | Name: NoEos | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: R',
        footer,
      ].join('\n');
      const result = parseListPlayersDetailed(raw);
      expect(result.players).toEqual([]);
      expect(result.activeRows).toBe(1);
      expect(result.unparsedRows).toHaveLength(1);
    });
  });
});
