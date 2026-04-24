import { describe, expect, it } from 'vitest';
import { parseServerInfo } from '../src/parse-server-info.js';

describe('ShowServerInfo parser', () => {
  it('extracts tickrate, player count, map, and mode from a full payload', () => {
    const raw = JSON.stringify({
      MaxPlayers: 100,
      PlayerCount_I: '42',
      ServerName_s: '[RU] Squad Server',
      MapName_s: 'CAF_Goose_Bay_AAS_v1',
      NextLayer_s: 'Fallujah_RAAS_v1',
      GameMode_s: 'AAS',
      GameVersion_s: 'V9.1.0.39430.0',
      ServerTickRate: 49.5,
      TeamOne_s: 'CAF+GBAC',
      TeamTwo_s: 'RGF+Motorized',
      PublicQueue_I: '3',
      ReservedQueue_I: '0',
    });
    const info = parseServerInfo(raw);
    expect(info).not.toBeNull();
    expect(info?.tickrate).toBe(49.5);
    expect(info?.player_count).toBe(42);
    expect(info?.max_players).toBe(100);
    expect(info?.map_name).toBe('CAF_Goose_Bay_AAS_v1');
    expect(info?.next_layer).toBe('Fallujah_RAAS_v1');
    expect(info?.game_mode).toBe('AAS');
    expect(info?.server_name).toBe('[RU] Squad Server');
    expect(info?.public_queue).toBe(3);
  });

  it('returns null for non-JSON output (older Squad versions or RCON errors)', () => {
    expect(parseServerInfo('')).toBeNull();
    expect(parseServerInfo('   ')).toBeNull();
    expect(parseServerInfo('not json')).toBeNull();
  });

  it('tolerates missing fields and returns nulls instead of throwing', () => {
    const info = parseServerInfo(JSON.stringify({ MaxPlayers: 80 }));
    expect(info).not.toBeNull();
    expect(info?.max_players).toBe(80);
    expect(info?.tickrate).toBeNull();
    expect(info?.map_name).toBeNull();
  });

  it('falls back to CurrentMap_s when MapName_s is absent', () => {
    const info = parseServerInfo(JSON.stringify({ CurrentMap_s: 'Narva_AAS_v1' }));
    expect(info?.map_name).toBe('Narva_AAS_v1');
  });
});
